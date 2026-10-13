// Tempo map maths: no DOM here, so it can be tested on its own.
//
// A tempo map is a list of sections sorted by start time:
//   { start: seconds, bpm: number, beatsPerBar: integer }
// Each section's start is beat 1 of a bar, and its grid continues until the
// next section starts. The first section's grid also extends backwards, so
// pickup notes before the first downbeat still have beats to snap to.
//
// Snap divisions are "points per beat": 1 = beat, 2 = half-beats (8ths in x/4),
// 4 = 16ths, 3 = triplets, 6 = 16th-note triplets, and so on.

(function (root) {
  'use strict';

  const EPS = 1e-9;

  function normalize(sections) {
    return (sections || [])
      .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.bpm) && s.bpm > 0)
      .map((s) => ({
        start: s.start,
        bpm: s.bpm,
        beatsPerBar: Math.max(1, Math.round(Number(s.beatsPerBar) || 4)),
      }))
      .sort((a, b) => a.start - b.start)
      // Two sections can't start at the same moment; keep the later one in the list
      .filter((s, i, arr) => i === arr.length - 1 || arr[i + 1].start - s.start > 1e-6);
  }

  const beatLen = (s) => 60 / s.bpm;

  // Index of the section that governs time t (the first one for times before it)
  function sectionIndexAt(sections, t) {
    let lo = 0, hi = sections.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sections[mid].start <= t + EPS) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // Nearest grid point to t using any of the given divisions.
  // Returns t unchanged when there is no tempo map or no divisions.
  function snap(sections, t, divisions) {
    if (!sections.length || !divisions || !divisions.length) return t;
    const i = sectionIndexAt(sections, t);
    const s = sections[i];
    const end = i + 1 < sections.length ? sections[i + 1].start : Infinity;
    const len = beatLen(s);
    let best = t, bestDist = Infinity;
    const consider = (c) => {
      const d = Math.abs(c - t);
      if (d < bestDist - EPS) { best = c; bestDist = d; }
    };
    for (const d of divisions) {
      const step = len / d;
      let c = s.start + Math.round((t - s.start) / step) * step;
      if (i > 0 && c < s.start) c = s.start;
      if (c > end) c = end;
      consider(c);
    }
    if (i > 0) consider(s.start);
    if (end !== Infinity) consider(end);
    return best;
  }

  // Grid lines between t0 and t1.
  // level: 0 = bar line, 1 = beat, 2 = subdivision. `bar` is set on bar lines.
  function gridLines(sections, t0, t1, divisions, maxLines = 4000) {
    const out = [];
    if (!sections.length) return out;
    const divs = Array.from(new Set([1].concat(divisions || []))).sort((a, b) => a - b);
    const bars = barStarts(sections);
    const seen = new Set();
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const segStart = i === 0 ? -Infinity : s.start;
      const segEnd = i + 1 < sections.length ? sections[i + 1].start : Infinity;
      const lo = Math.max(t0, segStart);
      const hi = Math.min(t1, segEnd);
      if (lo > hi) continue;
      const len = beatLen(s);
      for (const d of divs) {
        const step = len / d;
        const k0 = Math.ceil((lo - s.start) / step - EPS);
        const k1 = Math.floor((hi - s.start) / step + EPS);
        for (let k = k0; k <= k1; k++) {
          const time = s.start + k * step;
          if (time >= segEnd - EPS) break; // belongs to the next section
          const key = Math.round(time * 1e6);
          if (seen.has(key)) continue;
          seen.add(key);
          let level = 2, bar;
          if (k % d === 0) {
            const beat = k / d;
            const inBar = ((beat % s.beatsPerBar) + s.beatsPerBar) % s.beatsPerBar;
            if (inBar === 0) { level = 0; bar = bars[i] + Math.floor(beat / s.beatsPerBar) + 1; } else level = 1;
          }
          out.push({ time, level, bar });
          if (out.length >= maxLines) return out.sort((a, b) => a.time - b.time);
        }
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  // Number of bars before each section starts (a partial bar counts as a bar)
  function barStarts(sections) {
    const bars = [0];
    for (let i = 1; i < sections.length; i++) {
      const prev = sections[i - 1];
      const beats = (sections[i].start - prev.start) / beatLen(prev);
      bars.push(bars[i - 1] + Math.ceil(beats / prev.beatsPerBar - 1e-6));
    }
    return bars;
  }

  // Musical position of t: bar (1-based; 0 or less before the first downbeat)
  // and beat within that bar (1-based, fractional).
  function position(sections, t) {
    if (!sections.length) return null;
    const i = sectionIndexAt(sections, t);
    const s = sections[i];
    const beats = (t - s.start) / beatLen(s);
    const barIdx = Math.floor(beats / s.beatsPerBar + 1e-9);
    return {
      bar: barStarts(sections)[i] + barIdx + 1,
      beat: beats - barIdx * s.beatsPerBar + 1,
    };
  }

  // Fit evenly spaced taps: returns { start, bpm } (time of the first beat and
  // tempo), or null with fewer than 2 taps. Missed or doubled taps are tolerated
  // by numbering each tap by its distance from the first in median intervals.
  function fitTaps(taps) {
    if (!taps || taps.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < taps.length; i++) gaps.push(taps[i] - taps[i - 1]);
    const sorted = gaps.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (!(median > 0)) return null;
    const ks = taps.map((t) => Math.round((t - taps[0]) / median));
    const n = taps.length;
    let sk = 0, st = 0, skk = 0, skt = 0;
    for (let i = 0; i < n; i++) { sk += ks[i]; st += taps[i]; skk += ks[i] * ks[i]; skt += ks[i] * taps[i]; }
    const denom = n * skk - sk * sk;
    if (denom <= 0) return null;
    const slope = (n * skt - sk * st) / denom;
    const intercept = (st - slope * sk) / n;
    if (!(slope > 0)) return null;
    return { start: intercept, bpm: 60 / slope };
  }

  const api = { normalize, sectionIndexAt, snap, gridLines, position, fitTaps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TimemarkTempo = api;
})(typeof window !== 'undefined' ? window : this);
