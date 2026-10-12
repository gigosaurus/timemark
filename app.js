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
  };
  const REPEATABLE = new Set(['back', 'forward']);
  const PEAKS_PER_SEC = 400;
  // MP3s up to this size are decoded up front so seeking is exact (see loadFile)
  const MP3_DECODE_LIMIT = 20 * 1024 * 1024;
  const STORE_PREFIX = 'timemark:';

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
    labels: { tokens: [], ptr: 0 },
    rebinding: null,
    bindings: {},
    settings: { skip: 3, speed: 1, windowSec: 8, volume: 1 },
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
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1400);
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
      if (isAudio && !state.peaks) buildPeaks(file, token);
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
    waveWrap.hidden = !isAudio;
    $('#zoomLabel').hidden = !isAudio;
    if (isAudio) resizeCanvas();
  }

  async function prepareDecodedAudio(file, token) {
    state.preparing = true;
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

    // Second ticks
    const step = win <= 5 ? 0.5 : win <= 15 ? 1 : win <= 30 ? 2 : 5;
    ctx.font = `${11 * dpr}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let t = Math.ceil(Math.max(0, start) / step) * step; t <= start + win; t += step) {
      if (dur && t > dur) break;
      const x = Math.round((t - start) * pxPerSec);
      ctx.fillStyle = colors.grid;
      ctx.fillRect(x, 0, Math.max(1, dpr), waveH);
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

    // Marks
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
    const marks = state.marks;
    const rowEnds = [-Infinity, -Infinity, -Infinity]; // stack overlapping labels into rows
    const tagH = 16 * dpr;
    const first = lowerBound(marks, start);
    const last = lowerBound(marks, start + win + 1e-9);
    const markX = (m) => Math.round((m.time - start) * pxPerSec);
    ctx.fillStyle = colors.mark;
    for (let i = first; i < last; i++) ctx.fillRect(markX(marks[i]) - dpr, 0, 2 * dpr, waveH);
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
        <button class="icon set" type="button" title="Move this mark to the current time">⤓</button>
        <button class="icon del" type="button" title="Delete">✕</button>`;
      li.querySelector('.time').textContent = formatTime(m.time);
      li.querySelector('.label').value = m.label;
      frag.appendChild(li);
    });
    markList.replaceChildren(frag);
    $('#markCount').textContent = state.marks.length;
    $('#emptyMarks').hidden = state.marks.length > 0;

    progressMarks.replaceChildren(...buildProgressMarks());

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
      removeMark(id);
    } else if (e.target.closest('.set')) {
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
    const out = {
      file: state.file ? state.file.name : null,
      duration: Math.round(duration() * 1000) / 1000,
      timestamps: state.marks.map((m, i) => ({
        index: i + 1,
        time: Math.round(m.time * 1000) / 1000,
        timecode: formatTime(m.time, true),
        label: m.label,
      })),
    };
    download(baseName() + '.json', JSON.stringify(out, null, 2) + '\n', 'application/json');
  });

  // ---------------------------------------------------------------------------
  // Auto-labels
  // ---------------------------------------------------------------------------

  function parseLabels() {
    const text = $('#labelText').value;
    const mode = $('#labelMode').value;
    state.labels.tokens = mode === 'lines'
      ? text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : text.split(/\s+/).filter(Boolean);
    state.labels.ptr = clamp(state.labels.ptr, 0, state.labels.tokens.length);
    renderLabelQueue();
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
    const { tokens } = state.labels;
    if (!tokens.length || !state.marks.length) { toast('Add some text and some marks first'); return; }
    state.marks.forEach((m, i) => { m.label = tokens[i] || ''; m.usedLabel = false; });
    state.labels.ptr = Math.min(tokens.length, state.marks.length);
    renderLabelQueue();
    renderMarks();
    saveMarks();
    toast(`Labelled ${Math.min(tokens.length, state.marks.length)} marks`);
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
  // Don't let control buttons keep focus, so shortcut keys keep working cleanly
  $('#controls').addEventListener('mousedown', (e) => {
    if (e.target.closest('.ctrl')) e.preventDefault();
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

  // Waveform: click to jump to that point; drag to scrub like a tape
  (() => {
    let drag = null;
    waveCanvas.addEventListener('pointerdown', (e) => {
      if (!state.file || e.button !== 0) return;
      waveCanvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, t: media.currentTime, moved: false };
    });
    waveCanvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) {
        const w = waveCanvas.getBoundingClientRect().width;
        seek(drag.t - (dx / w) * state.settings.windowSec);
      }
    });
    waveCanvas.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) {
        const r = waveCanvas.getBoundingClientRect();
        const { start, win } = waveWindow();
        seek(start + ((e.clientX - r.left) / r.width) * win);
      }
      drag = null;
    });
    waveCanvas.addEventListener('pointercancel', () => { drag = null; });
  })();

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------

  let needsDraw = true;
  let lastTime = -1;

  function frame() {
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
        if (state.isAudio && !waveWrap.hidden) drawWave();
        needsDraw = false;
      }
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
    if (file) loadFile(file);
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
  renderLabelQueue();
  readColors();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', readColors);
  new ResizeObserver(resizeCanvas).observe(waveWrap);
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('pagehide', flushSave);
  requestAnimationFrame(frame);
})();
