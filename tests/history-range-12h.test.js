/**
 * Regression: GET /api/history?range=12h returned HTTP 500 "Query failed"
 * because server/lib/db.js:RANGE_INTERVALS was missing the `12h` entry even
 * though playground/index.html ships a "12h" button. The UI silently
 * dropped the empty response and the chart looked blank.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('getHistory / RANGE_INTERVALS — 12h support', () => {
  it('index.html declares a 12h range button', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'playground', 'index.html'), 'utf8');
    assert.match(html, /data-range="43200"/, 'index.html should expose a 12h (43200s) range button');
  });

  it('server/lib/db.js RANGE_INTERVALS covers every range that has a button', () => {
    // Read the source so we don't need a live DB to assert the mapping.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'db.js'), 'utf8');
    const match = src.match(/(?:var|let|const)\s+RANGE_INTERVALS\s*=\s*\{([^}]+)\}/);
    assert.ok(match, 'RANGE_INTERVALS object not found in db.js');
    const body = match[1];
    const ranges = ['1h', '6h', '12h', '24h', '7d', '30d', '1y'];
    for (const r of ranges) {
      assert.match(body, new RegExp("'" + r + "':\\s*'"), `RANGE_INTERVALS missing entry for '${r}'`);
    }
  });
});
