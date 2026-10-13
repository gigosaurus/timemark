// Run with: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tempo.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// 120 BPM from 1s (beat = 0.5s), then 90 BPM in 3/4 from 9s (beat = 0.6667s)
const map = T.normalize([
  { start: 9, bpm: 90, beatsPerBar: 3 },
  { start: 1, bpm: 120, beatsPerBar: 4 },
]);

test('normalize sorts sections and fills defaults', () => {
  assert.deepEqual(map.map((s) => s.start), [1, 9]);
  assert.equal(T.normalize([{ start: 0, bpm: 100 }])[0].beatsPerBar, 4);
  assert.equal(T.normalize([{ start: 0, bpm: 0 }, { start: 1, bpm: NaN }]).length, 0);
});

test('snap to beats, 16ths and triplets', () => {
  close(T.snap(map, 1.26, [1]), 1.5);
  close(T.snap(map, 1.26, [4]), 1.25);
  close(T.snap(map, 1.32, [3]), 1 + 2 * (0.5 / 3));
  // Union of straight and triplet divisions picks whichever is closer
  close(T.snap(map, 1.17, [2, 3]), 1 + 0.5 / 3);
  close(T.snap(map, 1.24, [2, 3]), 1.25);
});

test('snap respects tempo changes', () => {
  close(T.snap(map, 9.7, [1]), 9 + 2 / 3);
  // Just before the change: the change point itself is the nearest grid point
  close(T.snap(map, 8.95, [1]), 9);
  // Pickup before the first downbeat still has beats
  close(T.snap(map, 0.6, [1]), 0.5);
});

test('snap is a no-op without a map or divisions', () => {
  assert.equal(T.snap([], 1.234, [1]), 1.234);
  assert.equal(T.snap(map, 1.234, []), 1.234);
});

test('grid lines mark bars, beats and subdivisions', () => {
  const lines = T.gridLines(map, 0.99, 3.01, [2]);
  assert.deepEqual(lines.map((l) => l.time), [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3]);
  assert.deepEqual(lines.map((l) => l.level), [0, 2, 1, 2, 1, 2, 1, 2, 0]);
  assert.equal(lines[0].bar, 1);
  assert.equal(lines[8].bar, 2);
  // Second section starts a new bar: 8s of 120 BPM = 16 beats = 4 bars, so bar 5
  const after = T.gridLines(map, 8.99, 9.01, []);
  assert.equal(after.length, 1);
  assert.equal(after[0].bar, 5);
});

test('musical position', () => {
  assert.deepEqual(T.position(map, 1), { bar: 1, beat: 1 });
  const p = T.position(map, 3.25);
  assert.equal(p.bar, 2);
  close(p.beat, 1.5);
  const q = T.position(map, 9 + 4 * (2 / 3)); // 3/4 bar: beat 4 is beat 1 of next bar
  assert.equal(q.bar, 6);
  close(q.beat, 2);
});

test('tap fitting tolerates jitter and a missed tap', () => {
  const taps = [2.003, 2.498, 3.001, 3.502, 4.497, 5.0, 5.503];
  const fit = T.fitTaps(taps);
  close(fit.bpm, 120, 0.5);
  close(fit.start, 2, 0.01);
  assert.equal(T.fitTaps([1]), null);
});
