(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  const ACTIONS = {
    back:    { label: 'Go back',      defaults: ['KeyA', 'ArrowLeft'] },
    play:    { label: 'Play',         defaults: ['KeyS'] },
    pause:   { label: 'Pause',        defaults: ['KeyD'] },
    forward: { label: 'Go forward',   defaults: ['KeyF', 'ArrowRight'] },
    mark:    { label: 'Mark',         defaults: ['Space'] },
    undo:    { label: 'Undo last mark', defaults: ['KeyZ', 'Backspace'] },
    tap:     { label: 'Tap tempo (step 2)', defaults: ['KeyT'] },
  };
  const REPEATABLE = new Set(['back', 'forward']);
  const PEAKS_PER_SEC = 400;
  // MP3s up to this size are decoded up front so seeking is exact (see loadFile)
  const MP3_DECODE_LIMIT = 20 * 1024 * 1024;
  const STORE_PREFIX = 'timemark:';
  // Step 2 shows a waveform under videos too; skip decoding audio from huge files
  const VIDEO_WAVE_LIMIT = 300 * 1024 * 1024;
  const HISTORY_LIMIT = 100;
  const T = window.TimemarkTempo;

  // ---------------------------------------------------------------------------
  // Elements
  // ---------------------------------------------------------------------------

  const media = $('#media');
  const stage = $('#stage');
  const fileInput = $('#fileInput');
  const waveWrap = $('#waveWrap');
  const waveCanvas = $('#wave');
  const waveStatus = $('#waveStatus');
  const progress = $('#progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressHead = progress.querySelector('.progress-head');
  const progressMarks = progress.querySelector('.progress-marks');
  const curTimeEl = $('#curTime');
  const durTimeEl = $('#durTime');
  const markList = $('#markList');
  const toastEl = $('#toast');

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    file: null,
    objectUrl: null,
    playbackUrl: null,  // decoded copy of the file, when we make one
    preparing: false,
    isAudio: false,
    marks: [],          // { id, time, label } sorted by time
    addStack: [],       // ids in the order they were added (for undo)
    nextId: 1,
    peaks: null,        // { min: Float32Array, max: Float32Array, rate }
    loadToken: 0,
    currentIdx: -1,
    labels: { tokens: [], ptr: 0, source: null },
    rebinding: null,
    bindings: {},
    settings: { skip: 3, speed: 1, windowSec: 8, volume: 1 },
    step: 1,
    peaksRequested: false,
    // Step 2
    tempo: { sections: [], divisions: [1, 2, 4] },
    history: [],        // snapshots of { marks, sections } for "Undo change"
    taps: [],           // media times of the current run of taps
    tapHistoryPushed: false,
    dragMark: null,     // { id, time } while dragging a mark on the waveform
    metronome: false,
  };

  // ---------------------------------------------------------------------------
  // Storage (best-effort; app works fine without it)
  // ---------------------------------------------------------------------------

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(STORE_PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch { /* ignore */ }
    },
    remove(key) {
      try { localStorage.removeItem(STORE_PREFIX + key); } catch { /* ignore */ }
    },
  };

  const fileKey = () => state.file && `marks:${state.file.name}:${state.file.size}`;
  const tempoKey = () => state.file && `tempo:${state.file.name}:${state.file.size}`;

  function saveTempo() {
    const key = tempoKey();
    if (!key) return;
    store.set(key, { sections: state.tempo.sections, divisions: state.tempo.divisions });
  }

  function loadTempo() {
    const saved = store.get(tempoKey(), null);
    state.tempo.sections = T.normalize(saved && saved.sections);
    const divs = saved && Array.isArray(saved.divisions) ? saved.divisions.filter((d) => [1, 2, 3, 4, 6, 8].includes(d)) : null;
    state.tempo.divisions = divs || [1, 2, 4];
  }

  let saveTimer = 0;
  let pendingSave = null;
  function flushSave() {
    clearTimeout(saveTimer);
    if (pendingSave) pendingSave();
    pendingSave = null;
  }
  function saveMarks() {
    const key = fileKey();
    const marks = state.marks;
    if (!key) return;
    clearTimeout(saveTimer);
    pendingSave = () => {
      if (marks.length) store.set(key, marks.map(({ time, label }) => ({ time, label })));
      else store.remove(key);
    };
    saveTimer = setTimeout(flushSave, 250);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const duration = () => (Number.isFinite(media.duration) ? media.duration : 0);

  function formatTime(t, forceHours = false) {
    const totalMs = Math.max(0, Math.round(t * 1000));
    const ms = totalMs % 1000;
    const s = Math.floor(totalMs / 1000) % 60;
    const m = Math.floor(totalMs / 60000) % 60;
    const h = Math.floor(totalMs / 3600000);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    if (h || forceHours || duration() >= 3600) return `${forceHours ? pad(h) : h}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
    return `${m}:${pad(s)}.${pad(ms, 3)}`;
  }

  function keyName(code) {
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    return {
      Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
      Backspace: 'Backspace', Enter: 'Enter', Comma: ',', Period: '.', Slash: '/',
      Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\',
      Minus: '-', Equal: '=', Backquote: '`', Delete: 'Del', Tab: 'Tab',
    }[code] || code;
  }

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), Math.max(1400, msg.length * 45));
  }

  function isTypingTarget(el) {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'file'].includes(el.type);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Loading a file
  // ---------------------------------------------------------------------------

  function looksLikeMedia(file) {
    return /^(audio|video)\//.test(file.type) ||
      /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|weba|mp4|m4v|webm|mov|mkv|ogv)$/i.test(file.name);
  }

  function isMp3(file) {
    return /^audio\/(mpeg|mp3)$/.test(file.type) || /\.mp3$/i.test(file.name);
  }

  function loadFile(file) {
    if (!file) return;
    if (!looksLikeMedia(file)) {
      toast('That doesn’t look like an audio or video file');
      return;
    }

    flushSave();
    const token = ++state.loadToken;
    media.pause();
    media.removeAttribute('src');
    media.load();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    if (state.playbackUrl) URL.revokeObjectURL(state.playbackUrl);

    state.file = file;
    state.objectUrl = URL.createObjectURL(file);
    state.playbackUrl = null;
    state.peaks = null;
    state.marks = [];
    state.addStack = [];
    state.currentIdx = -1;
    state.peaksRequested = false;
    state.history = [];
    state.taps = [];
    state.dragMark = null;
    loadTempo();
    resetMetronome();

    // Restore any marks previously saved for this file
    const saved = store.get(fileKey(), []);
    if (Array.isArray(saved) && saved.length) {
      state.marks = saved
        .filter((m) => m && Number.isFinite(m.time))
        .map((m) => ({ id: state.nextId++, time: m.time, label: String(m.label || '') }))
        .sort((a, b) => a.time - b.time);
    }

    $('#fileName').textContent = file.name;
    $('#fileName').hidden = false;
    $('#dropzone').hidden = true;
    $('#workspace').hidden = false;
    stage.classList.remove('is-audio', 'is-video');
    waveWrap.hidden = true;
    $('#zoomLabel').hidden = true;
    durTimeEl.textContent = formatTime(0);

    renderMarks();
    renderBeatPanel();
    if (state.marks.length) toast(`Restored ${state.marks.length} saved timestamp${state.marks.length === 1 ? '' : 's'}`);

    // Browsers seek MP3s by estimating byte offsets, which for VBR files without a
    // seek table lands audibly in the wrong place. Decoding up front and playing an
    // uncompressed copy makes every seek exact.
    if (isMp3(file) && file.size <= MP3_DECODE_LIMIT) prepareDecodedAudio(file, token);
    else {
      attachSource(state.objectUrl, token);
      if (isMp3(file)) toast('Large MP3: skips may land slightly off. WAV, OGG or M4A give exact timing.');
    }
  }

  function attachSource(url, token) {
    const file = state.file;
    media.src = url;
    media.playbackRate = state.settings.speed;
    media.volume = state.settings.volume;

    media.addEventListener('loadedmetadata', function onMeta() {
      if (token !== state.loadToken) return;
      const isAudio = !media.videoWidth || /^audio\//.test(file.type);
      showStage(isAudio);
      durTimeEl.textContent = formatTime(duration());
      renderMarks();
      updateWaveVisibility();
      media.playbackRate = state.settings.speed; // some browsers reset this on load
      updatePlayState();
    }, { once: true });

    media.addEventListener('error', function onErr() {
      if (token !== state.loadToken) return;
      toast('Your browser can’t play this file format');
    }, { once: true });
  }

  function showStage(isAudio) {
    state.isAudio = isAudio;
    stage.classList.remove('is-audio', 'is-video');
    stage.classList.add(isAudio ? 'is-audio' : 'is-video');
    updateWaveVisibility();
  }

  // Audio always shows the waveform; video shows it in step 2 (for the beat grid)
  function updateWaveVisibility() {
    if (!stage.classList.contains('is-audio') && !stage.classList.contains('is-video')) return;
    const show = state.isAudio || state.step === 2;
    waveWrap.hidden = !show;
    $('#zoomLabel').hidden = !show;
    if (!show) return;
    resizeCanvas();
    if (!state.peaks && !state.peaksRequested && !state.preparing) {
      state.peaksRequested = true;
      if (state.isAudio || state.file.size <= VIDEO_WAVE_LIMIT) buildPeaks(state.file, state.loadToken);
      else waveStatus.textContent = 'File too large to draw a waveform; the beat grid still works';
    }
  }

  async function prepareDecodedAudio(file, token) {
    state.preparing = true;
    state.peaksRequested = true;
    showStage(true);
    waveStatus.textContent = 'Preparing audio…';
    let url = state.objectUrl;
    try {
      const buffer = await decodeFile(file, 44100);
      if (token !== state.loadToken) return;
      state.peaks = computePeaks(buffer);
      state.playbackUrl = URL.createObjectURL(encodeWav(buffer));
      url = state.playbackUrl;
      waveStatus.textContent = '';
    } catch (err) {
      if (token !== state.loadToken) return;
      console.warn('MP3 decode failed; falling back to direct playback', err);
      waveStatus.textContent = '';
      state.peaksRequested = false; // let the normal waveform path try instead
    } finally {
      if (token === state.loadToken) state.preparing = false;
    }
    attachSource(url, token);
    needsDraw = true;
  }

  // 16-bit PCM WAV
  function encodeWav(buffer) {
    const nc = buffer.numberOfChannels;
    const len = buffer.length;
    const sr = buffer.sampleRate;
    const dataBytes = len * nc * 2;
    const out = new DataView(new ArrayBuffer(44 + dataBytes));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
    str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, nc, true);
    out.setUint32(24, sr, true); out.setUint32(28, sr * nc * 2, true); out.setUint16(32, nc * 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, dataBytes, true);
    const channels = [];
    for (let c = 0; c < nc; c++) channels.push(buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < nc; c++) {
        const v = Math.max(-1, Math.min(1, channels[c][i]));
        out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  // ---------------------------------------------------------------------------
  // Waveform
  // ---------------------------------------------------------------------------

  async function decodeFile(file, sampleRate) {
    const data = await file.arrayBuffer();
    let ctx;
    try { ctx = new OfflineAudioContext(1, 1, sampleRate); } catch { ctx = new OfflineAudioContext(1, 1, 44100); }
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && p.catch) p.catch(reject);
    });
  }

  function computePeaks(buffer) {
    const sr = buffer.sampleRate;
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const len = buffer.length;
    const bucket = Math.max(1, Math.floor(sr / PEAKS_PER_SEC));
    const rate = sr / bucket;
    const n = Math.ceil(len / bucket);
    const min = new Float32Array(n);
    const max = new Float32Array(n);
    const nc = channels.length;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      let lo = 1, hi = -1;
      const end = Math.min(len, (i + 1) * bucket);
      for (let j = i * bucket; j < end; j++) {
        let v = 0;
        for (let c = 0; c < nc; c++) v += channels[c][j];
        v /= nc;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[i] = lo; max[i] = hi;
      peak = Math.max(peak, -lo, hi);
    }
    // Normalise so quiet recordings are still visible
    if (peak > 0) {
      const k = 1 / peak;
      for (let i = 0; i < n; i++) { min[i] *= k; max[i] *= k; }
    }
    return { min, max, rate };
  }

  async function buildPeaks(file, token) {
    waveStatus.textContent = 'Analysing audio…';
    try {
      // Decode at a low sample rate: plenty for a waveform and much lighter on memory.
      const buffer = await decodeFile(file, 8000);
      if (token !== state.loadToken) return;
      state.peaks = computePeaks(buffer);
      waveStatus.textContent = '';
    } catch (err) {
      if (token !== state.loadToken) return;
      console.warn('Waveform decode failed', err);
      state.peaks = null;
      waveStatus.textContent = 'Couldn’t draw a waveform for this file (playback still works)';
    }
    needsDraw = true;
  }

  let colors = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    colors = {
      wave: v('--wave'), played: v('--wave-played'), grid: v('--grid'), bg: v('--wave-bg'),
      mark: v('--mark'), text: v('--muted'), head: v('--accent'),
      gridBar: v('--grid-bar'), gridBeat: v('--grid-beat'), gridSub: v('--grid-sub'),
    };
    needsDraw = true;
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = waveCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (waveCanvas.width !== w || waveCanvas.height !== h) {
      waveCanvas.width = w;
      waveCanvas.height = h;
    }
    needsDraw = true;
  }

  function waveWindow() {
    const win = state.settings.windowSec;
    return { start: media.currentTime - win / 2, win };
  }

  function drawWave() {
    const ctx = waveCanvas.getContext('2d');
    const W = waveCanvas.width;
    const H = waveCanvas.height;
    const dpr = window.devicePixelRatio || 1;
    const { start, win } = waveWindow();
    const pxPerSec = W / win;
    const dur = duration();
    const axisH = Math.round(18 * dpr);
    const waveH = H - axisH;
    const mid = waveH / 2;
    const amp = waveH / 2 - 6 * dpr;
    const headX = Math.round(W / 2);

    ctx.clearRect(0, 0, W, H);

    // Out-of-range shading (before 0 / after end)
    ctx.fillStyle = colors.grid;
    if (start < 0) ctx.fillRect(0, 0, Math.min(W, -start * pxPerSec), waveH);
    if (dur && start + win > dur) {
      const x = (dur - start) * pxPerSec;
      ctx.fillRect(x, 0, W - x, waveH);
    }

    const showGrid = state.step === 2 && state.tempo.sections.length > 0;

    // Second ticks (just the labels when the beat grid is drawn)
    const step = win <= 5 ? 0.5 : win <= 15 ? 1 : win <= 30 ? 2 : 5;
    ctx.font = `${11 * dpr}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let t = Math.ceil(Math.max(0, start) / step) * step; t <= start + win; t += step) {
      if (dur && t > dur) break;
      const x = Math.round((t - start) * pxPerSec);
      if (!showGrid) {
        ctx.fillStyle = colors.grid;
        ctx.fillRect(x, 0, Math.max(1, dpr), waveH);
      }
      ctx.fillStyle = colors.text;
      const label = formatTime(t).replace(/\.?0+$/, '').replace(/\.$/, '');
      ctx.fillText(label, x, waveH + axisH / 2);
    }

    // Waveform
    const p = state.peaks;
    if (p) {
      const n = p.min.length;
      const bucketsPerPx = p.rate / pxPerSec;
      for (let x = 0; x < W; x++) {
        const t0 = start + x / pxPerSec;
        let i0 = Math.floor(t0 * p.rate);
        let i1 = Math.floor((t0 + 1 / pxPerSec) * p.rate);
        if (i1 <= i0) i1 = i0 + 1;
        if (i1 <= 0 || i0 >= n) continue;
        i0 = Math.max(0, i0); i1 = Math.min(n, i1);
        let lo = 1, hi = -1;
        for (let i = i0; i < i1; i++) {
          if (p.min[i] < lo) lo = p.min[i];
          if (p.max[i] > hi) hi = p.max[i];
        }
        if (bucketsPerPx < 1) { lo = Math.min(lo, -0.01); hi = Math.max(hi, 0.01); }
        const y0 = mid - hi * amp;
        const y1 = mid - lo * amp;
        ctx.fillStyle = x < headX ? colors.played : colors.wave;
        ctx.fillRect(x, y0, 1, Math.max(dpr, y1 - y0));
      }
    } else {
      ctx.fillStyle = colors.wave;
      ctx.fillRect(0, mid, W, Math.max(1, dpr));
    }

    // Beat grid
    if (showGrid) {
      const lines = T.gridLines(state.tempo.sections, Math.max(0, start), dur ? Math.min(dur, start + win) : start + win, state.tempo.divisions);
      // Leave out subdivisions that would be too dense to read
      let minGap = Infinity;
      for (let i = 1; i < lines.length; i++) minGap = Math.min(minGap, lines[i].time - lines[i - 1].time);
      const drawSubs = minGap * pxPerSec >= 4 * dpr;
      ctx.font = `600 ${10 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      for (const line of lines) {
        if (line.level === 2 && !drawSubs) continue;
        const x = Math.round((line.time - start) * pxPerSec);
        ctx.fillStyle = line.level === 0 ? colors.gridBar : line.level === 1 ? colors.gridBeat : colors.gridSub;
        ctx.fillRect(x, 0, Math.max(1, line.level === 0 ? 2 * dpr : dpr), waveH);
        if (line.level === 0 && line.bar != null) {
          ctx.fillStyle = colors.text;
          ctx.fillText(String(line.bar), x + 3 * dpr, waveH - 2 * dpr);
        }
      }
    }

    // Marks
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
    const drag = state.dragMark;
    const marks = drag
      ? state.marks.map((m) => (m.id === drag.id ? { ...m, time: drag.time } : m)).sort((a, b) => a.time - b.time)
      : state.marks;
    const rowEnds = [-Infinity, -Infinity, -Infinity]; // stack overlapping labels into rows
    const tagH = 16 * dpr;
    const first = lowerBound(marks, start);
    const last = lowerBound(marks, start + win + 1e-9);
    const markX = (m) => Math.round((m.time - start) * pxPerSec);
    // Where each mark would snap to (step 2)
    if (showGrid && state.tempo.divisions.length) {
      ctx.strokeStyle = colors.mark;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.globalAlpha = 0.8;
      for (let i = first; i < last; i++) {
        if (drag && marks[i].id === drag.id) continue;
        const target = T.snap(state.tempo.sections, marks[i].time, state.tempo.divisions);
        if (Math.abs(target - marks[i].time) < 0.0005) continue;
        const tx = Math.round((target - start) * pxPerSec) + 0.5;
        ctx.beginPath();
        ctx.moveTo(tx, 18 * dpr);
        ctx.lineTo(tx, waveH);
        ctx.stroke();
        // connector from the mark to its snap point
        const y = waveH - 10 * dpr;
        ctx.beginPath();
        ctx.moveTo(markX(marks[i]), y);
        ctx.lineTo(tx, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = colors.mark;
    for (let i = first; i < last; i++) {
      const w = drag && marks[i].id === drag.id ? 3 * dpr : 2 * dpr;
      ctx.fillRect(markX(marks[i]) - w / 2, 0, w, waveH);
    }
    for (let i = first; i < last; i++) {
      const x = markX(marks[i]);
      const text = marks[i].label || String(i + 1);
      const tw = ctx.measureText(text).width + 8 * dpr;
      const row = rowEnds.findIndex((end) => end < x);
      if (row < 0) continue; // too crowded to label; the line alone is drawn
      rowEnds[row] = x + tw + 2 * dpr;
      const y = row * (tagH + 2 * dpr);
      ctx.fillStyle = colors.mark;
      ctx.fillRect(x - dpr, y, tw, tagH);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x + 3 * dpr, y + 2.5 * dpr);
    }

    // Playhead
    ctx.fillStyle = colors.head;
    ctx.fillRect(headX - dpr, 0, 2 * dpr, waveH);
    ctx.beginPath();
    ctx.moveTo(headX - 6 * dpr, waveH);
    ctx.lineTo(headX + 6 * dpr, waveH);
    ctx.lineTo(headX, waveH - 7 * dpr);
    ctx.closePath();
    ctx.fill();
  }

  // ---------------------------------------------------------------------------
  // Playback actions
  // ---------------------------------------------------------------------------

  function seek(t) {
    if (!state.file) return;
    media.currentTime = clamp(t, 0, duration() || Infinity);
    needsDraw = true;
  }

  const actions = {
    play() {
      const p = media.play();
      if (p && p.catch) p.catch(() => {});
    },
    pause() { media.pause(); },
    back() { seek(media.currentTime - state.settings.skip); },
    forward() { seek(media.currentTime + state.settings.skip); },
    mark() { addMark(media.currentTime); },
    undo() { undoMark(); },
    tap() { tapTempo(); },
  };

  function runAction(name) {
    if (!state.file) return;
    if (state.preparing) { toast('Still preparing audio…'); return; }
    actions[name]();
    const btn = document.querySelector(`.ctrl[data-action="${name}"]`);
    if (btn) {
      btn.classList.add('flash');
      clearTimeout(btn._flashTimer);
      btn._flashTimer = setTimeout(() => btn.classList.remove('flash'), 120);
    }
  }

  // ---------------------------------------------------------------------------
  // Marks
  // ---------------------------------------------------------------------------

  // First index with marks[i].time >= t
  function lowerBound(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].time < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function addMark(time) {
    let label = '';
    let usedLabel = false;
    syncLabels();
    const L = state.labels;
    if (L.ptr < L.tokens.length) {
      label = L.tokens[L.ptr++];
      usedLabel = true;
      renderLabelQueue();
    }
    const mark = { id: state.nextId++, time, label, usedLabel };
    // Insert after any marks at the exact same time to keep order stable
    let i = lowerBound(state.marks, time);
    while (i < state.marks.length && state.marks[i].time === time) i++;
    state.marks.splice(i, 0, mark);
    state.addStack.push(mark.id);
    renderMarks(mark.id);
    saveMarks();
    toast(`Marked ${formatTime(time)}${label ? ` · ${label}` : ''}`);
  }

  function removeMark(id) {
    const i = state.marks.findIndex((m) => m.id === id);
    if (i < 0) return null;
    const [m] = state.marks.splice(i, 1);
    state.addStack = state.addStack.filter((x) => x !== id);
    renderMarks();
    saveMarks();
    return m;
  }

  function undoMark() {
    const id = state.addStack.pop();
    if (id == null) { toast('Nothing to undo'); return; }
    const m = removeMark(id);
    if (!m) return;
    if (m.usedLabel && state.labels.ptr > 0) {
      state.labels.ptr--;
      renderLabelQueue();
    }
    toast(`Removed ${formatTime(m.time)}`);
  }

  function renderMarks(newId) {
    const frag = document.createDocumentFragment();
    state.marks.forEach((m, i) => {
      const li = document.createElement('li');
      li.dataset.id = m.id;
      if (m.id === newId) li.classList.add('new');
      li.innerHTML = `
        <span class="idx">${i + 1}</span>
        <button class="time" type="button" title="Jump here"></button>
        <input class="label" type="text" placeholder="Label" aria-label="Label">
        <button class="icon snap" type="button" title="Snap this mark to the beat grid">♩</button>
        <button class="icon set" type="button" title="Move this mark to the current time">⤓</button>
        <button class="icon del" type="button" title="Delete">✕</button>
        <span class="beatpos"></span>`;
      li.querySelector('.time').textContent = formatTime(m.time);
      li.querySelector('.label').value = m.label;
      li.querySelector('.beatpos').textContent = beatPosText(m.time);
      frag.appendChild(li);
    });
    markList.replaceChildren(frag);
    $('#markCount').textContent = state.marks.length;
    $('#emptyMarks').hidden = state.marks.length > 0;

    progressMarks.replaceChildren(...buildProgressMarks());
    updateSnapPreview();

    state.currentIdx = -2; // force refresh of highlight
    updateCurrentMark();
    if (newId != null) {
      const el = markList.querySelector(`li[data-id="${newId}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    needsDraw = true;
  }

  function buildProgressMarks() {
    const dur = duration();
    if (!dur) return [];
    return state.marks.map((m) => {
      const el = document.createElement('i');
      el.style.left = `${(m.time / dur) * 100}%`;
      return el;
    });
  }

  function updateCurrentMark() {
    const t = media.currentTime;
    const idx = lowerBound(state.marks, t + 1e-6) - 1;
    if (idx === state.currentIdx) return;
    state.currentIdx = idx;
    markList.querySelectorAll('li.current').forEach((li) => li.classList.remove('current'));
    if (idx >= 0) {
      const li = markList.children[idx];
      if (li) {
        li.classList.add('current');
        if (!media.paused && !markList.matches(':hover')) li.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  markList.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const id = Number(li.dataset.id);
    const mark = state.marks.find((m) => m.id === id);
    if (!mark) return;
    if (e.target.closest('.time')) {
      seek(mark.time);
    } else if (e.target.closest('.del')) {
      if (state.step === 2) pushHistory();
      removeMark(id);
    } else if (e.target.closest('.snap')) {
      if (!state.tempo.sections.length) { toast('Set a tempo first'); return; }
      if (!state.tempo.divisions.length) { toast('Choose what to snap to first'); return; }
      const target = T.snap(state.tempo.sections, mark.time, state.tempo.divisions);
      if (Math.abs(target - mark.time) < 0.0005) { toast('Already on the grid'); return; }
      pushHistory();
      moveMark(id, target);
      toast(`Snapped to ${formatTime(target)}`);
    } else if (e.target.closest('.set')) {
      if (state.step === 2) pushHistory();
      const { label } = mark;
      removeMark(id);
      const t = media.currentTime;
      const m = { id: state.nextId++, time: t, label, usedLabel: false };
      state.marks.splice(lowerBound(state.marks, t), 0, m);
      renderMarks(m.id);
      saveMarks();
      toast(`Moved to ${formatTime(t)}`);
    }
  });

  // Move a mark to a new time, keeping the list sorted
  function moveMark(id, time) {
    const i = state.marks.findIndex((m) => m.id === id);
    if (i < 0) return;
    const [m] = state.marks.splice(i, 1);
    m.time = Math.max(0, time);
    let j = lowerBound(state.marks, m.time);
    while (j < state.marks.length && state.marks[j].time === m.time) j++;
    state.marks.splice(j, 0, m);
    renderMarks(id);
    saveMarks();
  }

  function beatPosText(t) {
    if (state.step !== 2 || !state.tempo.sections.length) return '';
    const p = T.position(state.tempo.sections, t);
    return `bar ${p.bar} · beat ${(Math.round(p.beat * 1000) / 1000).toString()}`;
  }

  markList.addEventListener('input', (e) => {
    if (!e.target.classList.contains('label')) return;
    const id = Number(e.target.closest('li').dataset.id);
    const mark = state.marks.find((m) => m.id === id);
    if (mark) {
      mark.label = e.target.value;
      saveMarks();
      needsDraw = true;
    }
  });

  markList.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('label') && (e.key === 'Enter' || e.key === 'Escape')) e.target.blur();
  });

  $('#clearBtn').addEventListener('click', () => {
    if (!state.marks.length) return;
    if (!confirm(`Delete all ${state.marks.length} timestamps?`)) return;
    state.marks = [];
    state.addStack = [];
    state.labels.ptr = 0;
    renderLabelQueue();
    renderMarks();
    saveMarks();
  });

  // ---------------------------------------------------------------------------
  // Step 2: beat grid & snapping
  // ---------------------------------------------------------------------------

  function setStep(step) {
    state.step = step;
    document.body.classList.toggle('step-2', step === 2);
    $$('.step').forEach((b) => b.setAttribute('aria-selected', String(Number(b.dataset.step) === step)));
    $('#beatPanel').hidden = step !== 2;
    if (step !== 2) resetMetronome();
    updateWaveVisibility();
    renderBeatPanel();
    renderMarks();
  }

  $$('.step').forEach((b) => b.addEventListener('click', () => setStep(Number(b.dataset.step))));

  // "Undo change" covers everything done in step 2: snapping, dragging and tempo edits
  function pushHistory() {
    state.history.push({
      marks: state.marks.map((m) => ({ ...m })),
      sections: state.tempo.sections.map((s) => ({ ...s })),
    });
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    $('#historyUndo').disabled = false;
  }

  $('#historyUndo').addEventListener('click', () => {
    const snap = state.history.pop();
    $('#historyUndo').disabled = !state.history.length;
    if (!snap) return;
    state.marks = snap.marks;
    state.tempo.sections = snap.sections;
    state.addStack = state.addStack.filter((id) => state.marks.some((m) => m.id === id));
    saveMarks();
    saveTempo();
    renderBeatPanel();
    renderMarks();
    toast('Undone');
  });

  function setSections(sections) {
    state.tempo.sections = T.normalize(sections);
    saveTempo();
    resetMetronome();
    renderBeatPanel();
    renderMarks();
  }

  // Accepts "1:23.456", "1:02:03.5" or plain seconds
  function parseTime(str) {
    const parts = String(str).trim().split(':');
    if (!parts.length || parts.length > 3 || parts.some((p) => p.trim() === '' || !/^\d*\.?\d*$/.test(p.trim()))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
  }

  const round3 = (n) => Math.round(n * 1000) / 1000;

  function renderBeatPanel() {
    const sections = state.tempo.sections;
    $('#tempoEmpty').hidden = sections.length > 0;
    $('#sectionTable').hidden = sections.length === 0;
    $('#nudgeRow').hidden = sections.length === 0;
    $('#historyUndo').disabled = !state.history.length;
    const rows = sections.map((s, i) => {
      const tr = document.createElement('tr');
      tr.dataset.index = i;
      tr.innerHTML = `
        <td><div class="start-cell">
          <input class="start" type="text" inputmode="decimal" aria-label="Section start time">
          <button class="icon set-start" type="button" title="Use the playhead position">⤓</button>
        </div></td>
        <td><input class="bpm" type="number" min="1" max="999" step="0.01" aria-label="BPM"></td>
        <td><input class="bpb" type="number" min="1" max="32" step="1" aria-label="Beats per bar"></td>
        <td>${i > 0 || sections.length > 1 ? '<button class="icon del-section" type="button" title="Remove this tempo section">✕</button>' : '<button class="icon del-section" type="button" title="Clear the tempo">✕</button>'}</td>`;
      tr.querySelector('.start').value = formatTime(s.start);
      tr.querySelector('.bpm').value = String(Math.round(s.bpm * 100) / 100);
      tr.querySelector('.bpb').value = String(s.beatsPerBar);
      return tr;
    });
    $('#sectionTable tbody').replaceChildren(...rows);
    $$('#divisions input').forEach((cb) => { cb.checked = state.tempo.divisions.includes(Number(cb.value)); });
    $('#metronome').checked = state.metronome;
    needsDraw = true;
  }

  $('#sectionTable').addEventListener('change', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const i = Number(tr.dataset.index);
    const sections = state.tempo.sections.map((s) => ({ ...s }));
    const s = sections[i];
    if (!s) return;
    if (e.target.classList.contains('start')) {
      const t = parseTime(e.target.value);
      if (!Number.isFinite(t)) { toast('Enter a time like 1:23.456'); renderBeatPanel(); return; }
      s.start = t;
    } else if (e.target.classList.contains('bpm')) {
      const v = parseFloat(e.target.value);
      if (!(v > 0)) { renderBeatPanel(); return; }
      s.bpm = v;
    } else if (e.target.classList.contains('bpb')) {
      const v = Math.round(parseFloat(e.target.value));
      if (!(v >= 1)) { renderBeatPanel(); return; }
      s.beatsPerBar = v;
    } else return;
    pushHistory();
    setSections(sections);
  });

  $('#sectionTable').addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && (e.key === 'Enter' || e.key === 'Escape')) e.target.blur();
  });

  $('#sectionTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const i = Number(tr.dataset.index);
    if (e.target.closest('.set-start')) {
      pushHistory();
      setSections(state.tempo.sections.map((s, j) => (j === i ? { ...s, start: media.currentTime } : s)));
    } else if (e.target.closest('.del-section')) {
      pushHistory();
      setSections(state.tempo.sections.filter((_, j) => j !== i));
    }
  });

  $('#setFirstBeat').addEventListener('click', () => {
    pushHistory();
    setSections([{ start: media.currentTime, bpm: 120, beatsPerBar: 4 }]);
    toast('Beat 1 set at the playhead. Now type the BPM.');
  });

  $('#addSection').addEventListener('click', () => {
    const sections = state.tempo.sections;
    const t = media.currentTime;
    if (!sections.length) {
      pushHistory();
      setSections([{ start: t, bpm: 120, beatsPerBar: 4 }]);
      toast('Beat 1 set at the playhead. Now type the BPM or tap along.');
      return;
    }
    // Tempo changes happen on a beat, so start at the beat nearest the playhead
    const at = T.snap(sections, t, [1]);
    if (sections.some((s) => Math.abs(s.start - at) < 1e-6)) { toast('A tempo section already starts here'); return; }
    const prev = sections[T.sectionIndexAt(sections, at)];
    pushHistory();
    setSections(sections.concat({ start: at, bpm: prev.bpm, beatsPerBar: prev.beatsPerBar }));
    toast(`Tempo change added at ${formatTime(at)}`);
  });

  $('#nudgeRow').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nudge]');
    if (!btn) return;
    const d = parseFloat(btn.dataset.nudge);
    pushHistory();
    setSections(state.tempo.sections.map((s) => ({ ...s, start: s.start + d })));
  });

  // Tap along with the music: taps are taken in media time, so they set both the
  // tempo and where beat 1 falls. A pause of 2+ seconds starts a new run.
  function tapTempo() {
    if (state.step !== 2) { toast('Tap tempo is in step 2 (Beat grid & snap)'); return; }
    if (media.paused) { toast('Play the track, then tap along on each beat'); return; }
    const t = media.currentTime;
    const last = state.taps[state.taps.length - 1];
    if (last == null || t < last || t - last > 2) {
      state.taps = [];
      state.tapHistoryPushed = false;
    }
    state.taps.push(t);
    const n = state.taps.length;
    const fit = T.fitTaps(state.taps);
    if (!fit || n < 4) {
      $('#tapStatus').textContent = '';
      $('#tempoEmpty').hidden = true;
      toast(n === 1 ? 'Tap… (first tap = beat 1)' : `Tap… ${n}`);
      return;
    }
    if (!state.tapHistoryPushed) { pushHistory(); state.tapHistoryPushed = true; }
    // Update the section the first tap falls in, or create the first one
    const sections = state.tempo.sections.map((s) => ({ ...s }));
    const bpm = Math.round(fit.bpm * 100) / 100;
    if (!sections.length) sections.push({ start: fit.start, bpm, beatsPerBar: 4 });
    else {
      const i = T.sectionIndexAt(sections, state.taps[0]);
      sections[i].start = fit.start;
      sections[i].bpm = bpm;
    }
    setSections(sections);
    $('#tapStatus').textContent = `${bpm} BPM from ${n} taps`;
    toast(`${bpm} BPM`);
  }

  $('#tapBtn').addEventListener('mousedown', (e) => e.preventDefault());
  $('#tapBtn').addEventListener('click', () => runAction('tap'));

  $('#divisions').addEventListener('change', () => {
    state.tempo.divisions = $$('#divisions input').filter((cb) => cb.checked).map((cb) => Number(cb.value));
    saveTempo();
    updateSnapPreview();
    needsDraw = true;
  });

  function snapTargets() {
    const { sections, divisions } = state.tempo;
    if (!sections.length || !divisions.length) return [];
    return state.marks
      .map((m) => ({ m, to: T.snap(sections, m.time, divisions) }))
      .filter(({ m, to }) => Math.abs(to - m.time) >= 0.0005);
  }

  function updateSnapPreview() {
    const el = $('#snapPreview');
    if (!el) return;
    const btn = $('#snapAll');
    if (!state.tempo.sections.length) { el.textContent = 'Set a tempo first'; btn.disabled = true; return; }
    if (!state.tempo.divisions.length) { el.textContent = 'Choose what to snap to'; btn.disabled = true; return; }
    const moves = snapTargets();
    btn.disabled = !moves.length;
    if (!state.marks.length) { el.textContent = 'No marks yet'; return; }
    if (!moves.length) { el.textContent = 'All marks are on the grid'; return; }
    const maxMs = Math.round(Math.max(...moves.map(({ m, to }) => Math.abs(to - m.time))) * 1000);
    el.textContent = `${moves.length} of ${state.marks.length} mark${state.marks.length === 1 ? '' : 's'} will move (largest move ${maxMs} ms)`;
  }

  $('#snapAll').addEventListener('click', () => {
    const moves = snapTargets();
    if (!moves.length) return;
    pushHistory();
    for (const { m, to } of moves) m.time = to;
    state.marks.sort((a, b) => a.time - b.time);
    renderMarks();
    saveMarks();
    toast(`Snapped ${moves.length} mark${moves.length === 1 ? '' : 's'}`);
  });

  // Metronome: clicks are scheduled a little ahead on the Web Audio clock,
  // converted from media time at the current playback rate.
  let audioCtx = null;
  const scheduled = new Set();
  function resetMetronome() { scheduled.clear(); }

  $('#metronome').addEventListener('change', (e) => {
    state.metronome = e.target.checked;
    if (state.metronome) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
      } catch {
        state.metronome = false;
        e.target.checked = false;
        toast('Your browser can’t play the metronome');
      }
    }
    resetMetronome();
  });

  function click(when, accent) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = accent ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(when);
    osc.stop(when + 0.06);
  }

  function scheduleMetronome() {
    if (!state.metronome || !audioCtx || state.step !== 2 || media.paused || !state.tempo.sections.length) return;
    const t = media.currentTime;
    const rate = media.playbackRate || 1;
    const ahead = 0.15 * rate;
    for (const line of T.gridLines(state.tempo.sections, t, t + ahead, [])) {
      const key = Math.round(line.time * 1000);
      if (scheduled.has(key)) continue;
      scheduled.add(key);
      click(audioCtx.currentTime + Math.max(0, (line.time - t) / rate), line.level === 0);
    }
    for (const key of scheduled) if (key < (t - 1) * 1000) scheduled.delete(key);
  }
  media.addEventListener('seeking', resetMetronome);
  media.addEventListener('pause', resetMetronome);

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  function baseName() {
    return (state.file ? state.file.name.replace(/\.[^.]+$/, '') : 'timestamps') + '-timestamps';
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $('#exportTxt').addEventListener('click', () => {
    if (!state.marks.length) { toast('No timestamps to export yet'); return; }
    const lines = state.marks.map((m) => formatTime(m.time, true) + (m.label ? `\t${m.label}` : ''));
    download(baseName() + '.txt', lines.join('\n') + '\n', 'text/plain');
  });

  $('#exportJson').addEventListener('click', () => {
    if (!state.marks.length) { toast('No timestamps to export yet'); return; }
    const sections = state.tempo.sections;
    const out = {
      file: state.file ? state.file.name : null,
      duration: round3(duration()),
      timestamps: state.marks.map((m, i) => {
        const row = { index: i + 1, time: round3(m.time), timecode: formatTime(m.time, true), label: m.label };
        if (sections.length) {
          const p = T.position(sections, m.time);
          row.bar = p.bar;
          row.beat = round3(p.beat);
        }
        return row;
      }),
    };
    if (sections.length) {
      out.tempo = sections.map((s) => ({ start: round3(s.start), bpm: s.bpm, beatsPerBar: s.beatsPerBar }));
    }
    download(baseName() + '.json', JSON.stringify(out, null, 2) + '\n', 'application/json');
  });

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------

  // Reads Timemark's own JSON export, a bare array (of seconds or of objects),
  // or the TXT export ("HH:MM:SS.mmm<tab>label" per line).
  // Returns { marks: [{ time, label }], tempo: sections | null, file, skipped }.
  function parseImport(text) {
    const trimmed = text.trim();
    let marks = [];
    let tempo = null;
    let file = null;
    let skipped = 0;
    const toTime = (v) => (typeof v === 'number' ? v : typeof v === 'string' ? parseTime(v) : NaN);

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const data = JSON.parse(trimmed);
      const list = Array.isArray(data) ? data : data.timestamps || data.marks;
      if (!Array.isArray(list)) throw new Error('No "timestamps" list found in this file');
      for (const item of list) {
        const obj = item && typeof item === 'object' ? item : { time: item };
        let t = toTime(obj.time);
        if (!Number.isFinite(t)) t = toTime(obj.timecode);
        if (!Number.isFinite(t) || t < 0) { skipped++; continue; }
        marks.push({ time: t, label: obj.label == null ? '' : String(obj.label) });
      }
      if (!Array.isArray(data)) {
        if (Array.isArray(data.tempo)) tempo = T.normalize(data.tempo);
        if (typeof data.file === 'string') file = data.file;
      }
    } else {
      for (const line of trimmed.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [timePart, ...rest] = line.split('\t');
        const t = parseTime(timePart);
        if (!Number.isFinite(t) || t < 0) { skipped++; continue; }
        marks.push({ time: t, label: rest.join('\t').trim() });
      }
    }
    marks.sort((a, b) => a.time - b.time);
    return { marks, tempo: tempo && tempo.length ? tempo : null, file, skipped };
  }

  function chooseImportMode(summary) {
    const dialog = $('#importDialog');
    $('#importSummary').textContent = summary;
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
      dialog.returnValue = '';
      dialog.showModal();
    });
  }

  async function importFile(file) {
    let parsed;
    try {
      parsed = parseImport(await file.text());
    } catch (err) {
      toast(err instanceof SyntaxError ? 'Couldn’t read that file: it isn’t valid JSON' : `Couldn’t read that file: ${err.message}`);
      return;
    }
    const { marks, tempo, skipped } = parsed;
    if (!marks.length && !tempo) { toast('No timestamps found in that file'); return; }

    let mode = 'replace';
    const n = state.marks.length;
    const replacesTempo = tempo && state.tempo.sections.length;
    if (n || replacesTempo) {
      const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
      const parts = [`This file has ${plural(marks.length, 'timestamp')}${tempo ? ' and a tempo map' : ''}.`];
      if (n) parts.push(`You already have ${plural(n, 'timestamp')}.`);
      if (replacesTempo) parts.push('The imported tempo map will replace your current one either way.');
      if (parsed.file && state.file && parsed.file !== state.file.name) parts.push(`It was made for “${parsed.file}”, not “${state.file.name}”.`);
      mode = await chooseImportMode(parts.join(' '));
      if (mode === 'cancel') return;
    }

    pushHistory();
    const incoming = marks.map((m) => ({ id: state.nextId++, time: m.time, label: m.label, usedLabel: false }));
    if (mode === 'replace') {
      state.marks = incoming;
      state.addStack = [];
      state.labels.ptr = 0;
      renderLabelQueue();
    } else {
      // Skip exact duplicates of marks that are already there
      const dup = (m) => state.marks.some((x) => Math.abs(x.time - m.time) < 0.0005 && x.label === m.label);
      state.marks = state.marks.concat(incoming.filter((m) => !dup(m))).sort((a, b) => a.time - b.time);
    }
    if (tempo) {
      state.tempo.sections = tempo;
      saveTempo();
      resetMetronome();
    }
    renderBeatPanel();
    renderMarks();
    saveMarks();

    const dur = duration();
    const beyond = dur ? marks.filter((m) => m.time > dur + 0.0005).length : 0;
    let msg = `Imported ${marks.length} timestamp${marks.length === 1 ? '' : 's'}${tempo ? ' and tempo map' : ''}`;
    if (skipped) msg += ` · skipped ${skipped} unreadable`;
    if (beyond) msg += ` · ${beyond} past the end of this file`;
    toast(msg);
  }

  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  });

  // ---------------------------------------------------------------------------
  // Auto-labels
  // ---------------------------------------------------------------------------

  function parseLabels() {
    const text = $('#labelText').value;
    const mode = $('#labelMode').value;
    state.labels.source = mode + '\n' + text;
    state.labels.tokens = mode === 'lines'
      ? text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : text.split(/\s+/).filter(Boolean);
    state.labels.ptr = clamp(state.labels.ptr, 0, state.labels.tokens.length);
    renderLabelQueue();
  }

  // Browsers can refill the text box (e.g. after a reload) without firing an
  // input event, so re-read it whenever the labels are about to be used.
  function syncLabels() {
    if (state.labels.source !== $('#labelMode').value + '\n' + $('#labelText').value) parseLabels();
  }

  function renderLabelQueue() {
    const { tokens, ptr } = state.labels;
    $('#nextLabel').textContent = tokens.length ? (ptr < tokens.length ? tokens[ptr] : '(end)') : '—';
    $('#labelPos').textContent = tokens.length ? `${Math.min(ptr + 1, tokens.length)}/${tokens.length}` : '';
    $('#labelPrev').disabled = ptr <= 0;
    $('#labelNext').disabled = ptr >= tokens.length;
  }

  $('#labelText').addEventListener('input', parseLabels);
  $('#labelMode').addEventListener('change', (e) => { e.target.blur(); state.labels.ptr = 0; parseLabels(); });
  $('#labelPrev').addEventListener('click', () => { state.labels.ptr = Math.max(0, state.labels.ptr - 1); renderLabelQueue(); });
  $('#labelNext').addEventListener('click', () => { state.labels.ptr = Math.min(state.labels.tokens.length, state.labels.ptr + 1); renderLabelQueue(); });
  $('#applyLabels').addEventListener('click', () => {
    syncLabels();
    const { tokens } = state.labels;
    if (!tokens.length) { toast('Paste some text into the box first'); return; }
    if (!state.marks.length) { toast('Add some marks first'); return; }
    const n = Math.min(tokens.length, state.marks.length);
    const overwritten = state.marks.slice(0, n).filter((m, i) => m.label && m.label !== tokens[i]).length;
    if (overwritten && !confirm(`This will replace ${overwritten} existing label${overwritten === 1 ? '' : 's'}. Continue?`)) return;
    // Marks beyond the end of the text keep whatever label they already have
    for (let i = 0; i < n; i++) { state.marks[i].label = tokens[i]; state.marks[i].usedLabel = false; }
    state.labels.ptr = n;
    renderLabelQueue();
    renderMarks();
    saveMarks();
    toast(`Labelled ${n} mark${n === 1 ? '' : 's'}` + (tokens.length > n ? ` · ${tokens.length - n} ${$('#labelMode').value === 'lines' ? 'lines' : 'words'} left over` : ''));
  });

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  let keyMap = new Map();

  function loadBindings() {
    const saved = store.get('bindings', null);
    state.bindings = {};
    for (const [name, a] of Object.entries(ACTIONS)) {
      const s = saved && Array.isArray(saved[name]) ? saved[name] : null;
      state.bindings[name] = s && s.length ? s.slice() : a.defaults.slice();
    }
    applyBindings();
  }

  function applyBindings() {
    keyMap = new Map();
    for (const [name, codes] of Object.entries(state.bindings)) {
      for (const code of codes) keyMap.set(code, name);
    }
    // Key hints on the control buttons and elsewhere
    $$('.ctrl').forEach((btn) => {
      const codes = state.bindings[btn.dataset.action] || [];
      btn.querySelector('kbd').textContent = codes.length ? keyName(codes[0]) : '';
      btn.title = `${ACTIONS[btn.dataset.action].label}${codes.length ? ` (${codes.map(keyName).join(' / ')})` : ''}`;
    });
    $$('[data-kbd]').forEach((el) => {
      const codes = state.bindings[el.dataset.kbd] || [];
      el.textContent = codes.length ? keyName(codes[0]) : '?';
    });
    renderKeysTable();
  }

  function renderKeysTable() {
    const rows = Object.entries(ACTIONS).map(([name, a]) => {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = a.label;
      const td2 = document.createElement('td');
      for (const code of state.bindings[name]) {
        const k = document.createElement('kbd');
        k.textContent = keyName(code);
        td2.appendChild(k);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small' + (state.rebinding === name ? ' listening' : '');
      btn.textContent = state.rebinding === name ? 'Press a key…' : 'Change';
      btn.addEventListener('click', () => {
        state.rebinding = state.rebinding === name ? null : name;
        renderKeysTable();
      });
      td2.appendChild(btn);
      tr.append(td1, td2);
      return tr;
    });
    $('#keysTable').replaceChildren(...rows);
  }

  function rebind(name, code) {
    for (const k of Object.keys(state.bindings)) {
      state.bindings[k] = state.bindings[k].filter((c) => c !== code);
    }
    state.bindings[name] = [code];
    state.rebinding = null;
    store.set('bindings', state.bindings);
    applyBindings();
    toast(`${ACTIONS[name].label} → ${keyName(code)}`);
  }

  $('#resetKeys').addEventListener('click', () => {
    store.remove('bindings');
    state.rebinding = null;
    loadBindings();
    toast('Shortcuts reset');
  });

  document.addEventListener('keydown', (e) => {
    if (state.rebinding) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { state.rebinding = null; renderKeysTable(); return; }
      if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'Tab'].includes(e.code)) return;
      rebind(state.rebinding, e.code);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (document.querySelector('dialog[open]')) return;
    const name = keyMap.get(e.code);
    if (!name || !state.file) return;
    e.preventDefault();
    if (e.repeat && !REPEATABLE.has(name)) return;
    runAction(name);
  }, true);

  // Stop a focused button from also being "clicked" by a shortcut key (e.g. Space)
  document.addEventListener('keyup', (e) => {
    if (keyMap.has(e.code) && e.target && e.target.tagName === 'BUTTON') e.preventDefault();
  }, true);

  // ---------------------------------------------------------------------------
  // On-screen controls & settings
  // ---------------------------------------------------------------------------

  $('#controls').addEventListener('click', (e) => {
    const btn = e.target.closest('.ctrl');
    if (btn) runAction(btn.dataset.action);
  });
  // Don't let control buttons take focus, and move focus out of any text box,
  // so shortcut keys work straight after clicking a control
  function releaseTextFocus() {
    if (isTypingTarget(document.activeElement)) document.activeElement.blur();
  }
  $('#controls').addEventListener('mousedown', (e) => {
    if (!e.target.closest('.ctrl')) return;
    e.preventDefault();
    releaseTextFocus();
  });
  progress.addEventListener('pointerdown', releaseTextFocus);
  waveCanvas.addEventListener('pointerdown', releaseTextFocus);

  // Shortcuts are ignored while typing; say so (checked every frame, because
  // focus can also be lost by re-rendering, which fires no event), and let Esc
  // get out of the box
  const typingHint = $('#typingHint');
  function updateTypingHint() {
    const typing = isTypingTarget(document.activeElement);
    if (typingHint.hidden === typing) typingHint.hidden = !typing;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isTypingTarget(e.target)) e.target.blur();
  });

  function applySettings() {
    const s = state.settings;
    $$('.skipVal').forEach((el) => { el.textContent = String(s.skip); });
    $('#skipInput').value = s.skip;
    $('#speedSelect').value = String(s.speed);
    $('#zoomSelect').value = String(s.windowSec);
    $('#volumeInput').value = s.volume;
    media.playbackRate = s.speed;
    media.volume = s.volume;
    needsDraw = true;
  }

  function saveSettings() { store.set('settings', state.settings); }

  $('#skipInput').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) state.settings.skip = Math.round(v * 100) / 100;
    applySettings();
    saveSettings();
  });
  $('#skipInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
  });
  $('#speedSelect').addEventListener('change', (e) => {
    state.settings.speed = parseFloat(e.target.value) || 1;
    e.target.blur();
    applySettings();
    saveSettings();
  });
  $('#zoomSelect').addEventListener('change', (e) => {
    state.settings.windowSec = parseFloat(e.target.value) || 8;
    e.target.blur();
    applySettings();
    saveSettings();
  });
  $('#volumeInput').addEventListener('input', (e) => {
    state.settings.volume = parseFloat(e.target.value);
    applySettings();
    saveSettings();
  });

  media.addEventListener('play', updatePlayState);
  media.addEventListener('pause', updatePlayState);
  media.addEventListener('ended', updatePlayState);
  function updatePlayState() {
    $('.ctrl[data-action="play"]').classList.toggle('active', !media.paused);
    $('.ctrl[data-action="pause"]').classList.toggle('active', media.paused && media.currentTime > 0);
  }
  media.addEventListener('durationchange', () => {
    durTimeEl.textContent = formatTime(duration());
    progressMarks.replaceChildren(...buildProgressMarks());
  });
  media.addEventListener('seeked', () => { needsDraw = true; });
  // Clicking the video toggles play/pause
  media.addEventListener('click', () => (media.paused ? actions.play() : actions.pause()));

  // ---------------------------------------------------------------------------
  // Seeking via the progress bar and the waveform
  // ---------------------------------------------------------------------------

  function bindScrub(el, timeAt) {
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      if (!state.file || e.button !== 0) return;
      dragging = true;
      el.setPointerCapture(e.pointerId);
      seek(timeAt(e));
    });
    el.addEventListener('pointermove', (e) => { if (dragging) seek(timeAt(e)); });
    const stop = () => { dragging = false; };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }

  bindScrub(progress, (e) => {
    const r = progress.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1) * duration();
  });

  // Waveform: click to jump to that point; drag to scrub like a tape.
  // In step 2, dragging a mark moves it (snapping to the grid unless Shift is held).
  (() => {
    let drag = null;
    const timeAtX = (clientX) => {
      const r = waveCanvas.getBoundingClientRect();
      const { start, win } = waveWindow();
      return start + ((clientX - r.left) / r.width) * win;
    };
    // The mark under the pointer (within a few pixels), if any
    const markAt = (clientX) => {
      if (state.step !== 2 || !state.marks.length) return null;
      const r = waveCanvas.getBoundingClientRect();
      const t = timeAtX(clientX);
      const tolerance = (6 / r.width) * state.settings.windowSec;
      const i = lowerBound(state.marks, t);
      let best = null, bestD = tolerance;
      for (const j of [i - 1, i]) {
        const m = state.marks[j];
        if (m && Math.abs(m.time - t) <= bestD) { best = m; bestD = Math.abs(m.time - t); }
      }
      return best;
    };
    const dragTime = (e) => {
      const t = Math.max(0, timeAtX(e.clientX));
      const { sections, divisions } = state.tempo;
      return e.shiftKey || !sections.length || !divisions.length ? t : T.snap(sections, t, divisions);
    };

    waveCanvas.addEventListener('pointerdown', (e) => {
      if (!state.file || e.button !== 0) return;
      waveCanvas.setPointerCapture(e.pointerId);
      const hit = markAt(e.clientX);
      if (hit) {
        drag = { mark: hit, x: e.clientX, moved: false };
        state.dragMark = { id: hit.id, time: hit.time };
      } else {
        drag = { x: e.clientX, t: media.currentTime, moved: false };
      }
      needsDraw = true;
    });
    waveCanvas.addEventListener('pointermove', (e) => {
      if (!drag) {
        waveWrap.classList.toggle('grab', !!markAt(e.clientX));
        return;
      }
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (!drag.moved) return;
      if (drag.mark) {
        state.dragMark.time = dragTime(e);
        needsDraw = true;
      } else {
        const w = waveCanvas.getBoundingClientRect().width;
        seek(drag.t - (dx / w) * state.settings.windowSec);
      }
    });
    waveCanvas.addEventListener('pointerup', (e) => {
      if (drag && drag.mark) {
        const to = state.dragMark.time;
        state.dragMark = null;
        if (drag.moved && Math.abs(to - drag.mark.time) >= 0.0005) {
          pushHistory();
          moveMark(drag.mark.id, to);
        } else if (!drag.moved) {
          seek(drag.mark.time);
        }
        needsDraw = true;
      } else if (drag && !drag.moved) {
        seek(timeAtX(e.clientX));
      }
      drag = null;
    });
    waveCanvas.addEventListener('pointercancel', () => { drag = null; state.dragMark = null; needsDraw = true; });
    waveCanvas.addEventListener('pointerleave', () => { if (!drag) waveWrap.classList.remove('grab'); });
  })();

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------

  let needsDraw = true;
  let lastTime = -1;

  function frame() {
    updateTypingHint();
    if (state.file) {
      const t = media.currentTime;
      if (t !== lastTime || needsDraw) {
        lastTime = t;
        curTimeEl.textContent = formatTime(t);
        const pct = duration() ? (t / duration()) * 100 : 0;
        progressFill.style.width = `${pct}%`;
        progressHead.style.left = `${pct}%`;
        progress.setAttribute('aria-valuenow', t.toFixed(3));
        updateCurrentMark();
        if (!waveWrap.hidden) drawWave();
        needsDraw = false;
      }
      scheduleMetronome();
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------------------
  // File picking & drag-and-drop
  // ---------------------------------------------------------------------------

  $('#openBtn').addEventListener('click', () => fileInput.click());
  $('#chooseBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });

  let dragDepth = 0;
  const overlay = $('#dragOverlay');
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const file = e.dataTransfer.files[0];
    if (!file) return;
    // A dropped .json/.txt imports timestamps into the open file
    if (/\.(json|txt)$/i.test(file.name) || /^(application\/json|text\/plain)$/.test(file.type)) {
      if (state.file) importFile(file);
      else toast('Open the audio or video file first, then import timestamps');
      return;
    }
    loadFile(file);
  });

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  const savedSettings = store.get('settings', null);
  if (savedSettings && typeof savedSettings === 'object') {
    for (const k of Object.keys(state.settings)) {
      if (Number.isFinite(savedSettings[k])) state.settings[k] = savedSettings[k];
    }
  }
  applySettings();
  loadBindings();
  setStep(1);
  parseLabels();
  // Pick up text the browser restores into the box after load / back-forward navigation
  window.addEventListener('load', syncLabels);
  window.addEventListener('pageshow', syncLabels);
  $('#labelDrawer').addEventListener('toggle', syncLabels);
  readColors();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', readColors);
  new ResizeObserver(resizeCanvas).observe(waveWrap);
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('pagehide', flushSave);
  requestAnimationFrame(frame);
})();
