// The CSS/JS links in index.html carry a ?v= cache-busting version; keep them in step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('asset links share one cache-busting version', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const versions = ['style.css', 'tempo.js', 'app.js'].map((f) => {
    const m = html.match(new RegExp(`${f.replace('.', '\\.')}\\?v=([\\w.-]+)`));
    assert.ok(m, `${f} has no ?v= version`);
    return m[1];
  });
  assert.equal(new Set(versions).size, 1, `versions differ: ${versions.join(', ')}`);
});
