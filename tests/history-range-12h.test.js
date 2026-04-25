/**
 * Regression: GET /api/history?range=12h returned HTTP 500 "Query failed"
 * because server/lib/db.js:RANGE_INTERVALS was missing the `12h` entry even
 * though playground/index.html ships a "12h" button. The UI silently
 * dropped the empty response and the chart looked blank.
 *
 * Extended to cover the progressive-slider step set: the Status view's
 * timeframe slider exposes 1h/6h/12h/24h/3d/7d/4mo steps (24h default,
 * 4mo upper bound). Every step must have a matching RANGE_INTERVALS entry.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SLIDER_STEPS = ['1h', '6h', '12h', '24h', '3d', '7d', '4mo'];

describe('getHistory / RANGE_INTERVALS — slider step coverage', () => {
  it('index.html declares the progressive timeframe slider with the expected step values', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'playground', 'index.html'), 'utf8');
    assert.match(html, /id="time-range-slider"/, 'index.html should expose a #time-range-slider element');
    const secondsForStep = { '1h': 3600, '6h': 21600, '12h': 43200, '24h': 86400, '3d': 259200, '7d': 604800, '4mo': 10368000 };
    for (const step of SLIDER_STEPS) {
      const secs = secondsForStep[step];
      assert.match(html, new RegExp(`data-range="${secs}"`), `slider markup should expose step ${step} (${secs}s)`);
    }
  });

  it('server/lib/db.js RANGE_INTERVALS covers every slider step', () => {
    // Read the source so we don't need a live DB to assert the mapping.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'db.js'), 'utf8');
    const match = src.match(/(?:var|let|const)\s+RANGE_INTERVALS\s*=\s*\{([^}]+)\}/);
    assert.ok(match, 'RANGE_INTERVALS object not found in db.js');
    const body = match[1];
    for (const r of SLIDER_STEPS) {
      assert.match(body, new RegExp("'" + r + "':\\s*'"), `RANGE_INTERVALS missing entry for '${r}'`);
    }
  });
});
