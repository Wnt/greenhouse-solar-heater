'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseWfsResponse, fetchForecast } = require('../server/lib/fmi-client.js');

const FIXTURE_PATH = path.join(__dirname, 'fixtures/forecast/fmi-harmonie-sample.xml');

describe('fmi-client parseWfsResponse', () => {
  it('parses fixture into 4 rows with correct values', () => {
    const xml = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const rows = parseWfsResponse(xml);

    assert.strictEqual(rows.length, 4, 'expected 4 rows (one per unique timestamp)');

    // Rows are sorted ascending by validAt.
    const first = rows[0];
    assert.ok(first.validAt instanceof Date, 'validAt should be a Date');
    assert.strictEqual(first.validAt.toISOString(), '2026-05-04T00:00:00.000Z');

    assert.strictEqual(first.temperature, 7.2);
    assert.strictEqual(first.windSpeed, 1.6);
    assert.strictEqual(first.precipitation, 0.0);
    assert.strictEqual(typeof first.radiationGlobal, 'number', 'radiationGlobal should be numeric');
  });

  it('maps all four parameters correctly across multiple timestamps', () => {
    const xml = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const rows = parseWfsResponse(xml);

    // Second timestamp: 01:00Z
    const second = rows[1];
    assert.strictEqual(second.validAt.toISOString(), '2026-05-04T01:00:00.000Z');
    assert.strictEqual(second.temperature, 6.9);
    assert.strictEqual(second.windSpeed, 1.65);

    // Last timestamp (03:00Z) has radiationGlobal 3.3
    const last = rows[3];
    assert.strictEqual(last.radiationGlobal, 3.3);
  });

  it('throws on non-FeatureCollection body', () => {
    assert.throws(
      () => parseWfsResponse('<error>bad</error>'),
      /FMI fetch failed/
    );
  });
});

// Live HTTPS call — opt-in via RUN_LIVE_NETWORK_TESTS=1. External service
// availability and cert rotations make this flaky in CI; fixture-based
// parsing tests above stay on by default.
describe('fmi-client live HTTPS call', () => {
  it('live FMI call', { skip: process.env.RUN_LIVE_NETWORK_TESTS !== '1' }, async () => {
    const rows = await fetchForecast({ lat: 60.41, lon: 22.37, hours: 3 });
    assert.ok(rows.length >= 1, 'expected at least one row');
    const first = rows[0];
    assert.ok(first.validAt instanceof Date);
    assert.strictEqual(typeof first.temperature, 'number');
    assert.strictEqual(typeof first.radiationGlobal, 'number');
    assert.strictEqual(typeof first.windSpeed, 'number');
    assert.strictEqual(typeof first.precipitation, 'number');
  });
});
