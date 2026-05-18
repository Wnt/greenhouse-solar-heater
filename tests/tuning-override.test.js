'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseTuningOverride } = require('../server/lib/forecast/tuning-override.js');

describe('parseTuningOverride', () => {
  it('returns null when no tu query param is present', () => {
    assert.equal(parseTuningOverride('/api/forecast'), null);
    assert.equal(parseTuningOverride('/api/forecast?engine=ml'), null);
  });

  it('returns null on unparseable JSON (graceful fallback to live forecast)', () => {
    assert.equal(parseTuningOverride('/api/forecast?tu=not-json'), null);
    assert.equal(parseTuningOverride('/api/forecast?tu=%7Bbroken'), null);
  });

  it('returns null when tu is not a plain object', () => {
    assert.equal(parseTuningOverride('/api/forecast?tu=' + encodeURIComponent('[1,2]')), null);
    assert.equal(parseTuningOverride('/api/forecast?tu=42'), null);
  });

  it('returns an empty map for tu={} (meaning: every threshold at default)', () => {
    assert.deepEqual(parseTuningOverride('/api/forecast?tu=' + encodeURIComponent('{}')), {});
  });

  it('extracts known numeric tuning keys', () => {
    const url = '/api/forecast?tu=' + encodeURIComponent(JSON.stringify({ geT: 13, ehE: 8 }));
    assert.deepEqual(parseTuningOverride(url), { geT: 13, ehE: 8 });
  });

  it('clamps out-of-range values to TUNING_RANGES', () => {
    const url = '/api/forecast?tu=' + encodeURIComponent(JSON.stringify({ geT: 999, ehE: -5 }));
    // geT range 0–25, ehE range 0–20.
    assert.deepEqual(parseTuningOverride(url), { geT: 25, ehE: 0 });
  });

  it('drops unknown keys and non-numeric values', () => {
    const url = '/api/forecast?tu=' + encodeURIComponent(JSON.stringify({
      geT: 12, bogus: 5, gxT: 'warm', ehE: null,
    }));
    assert.deepEqual(parseTuningOverride(url), { geT: 12 });
  });
});
