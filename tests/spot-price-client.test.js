'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const client = require('../server/lib/forecast/spot-price-client.js');
const { parseSahkotinCsv, parseNordpoolPredict, mergePrices, fetchPrices } = client;

const FIXTURES = path.join(__dirname, 'fixtures', 'forecast');

describe('spot-price-client', () => {
  describe('parseSahkotinCsv', () => {
    it('parses fixture into 46 rows with correct first entry', () => {
      const csv = fs.readFileSync(path.join(FIXTURES, 'sahkotin-sample.csv'), 'utf8');
      const rows = parseSahkotinCsv(csv);
      assert.strictEqual(rows.length, 46, 'expected 46 data rows');
      const first = rows[0];
      assert.deepStrictEqual(first.validAt, new Date('2026-05-03T00:00:00.000Z'));
      // sahkotin returns EUR/MWh; parser converts to c/kWh by /10.
      assert.strictEqual(first.priceCKwh, 1.945);
      assert.strictEqual(first.source, 'sahkotin');
    });
  });

  describe('parseNordpoolPredict', () => {
    it('parses fixture and applies Finnish VAT to first row', () => {
      const json = fs.readFileSync(path.join(FIXTURES, 'nordpool-predict-sample.json'), 'utf8');
      const rows = parseNordpoolPredict(json);
      assert.ok(rows.length > 0, 'expected at least one row');
      const first = rows[0];
      const expected = Math.round(1.1804184913635254 * 1.255 * 10000) / 10000;
      assert.strictEqual(first.priceCKwh, expected);
      assert.strictEqual(first.source, 'nordpool-predict');
    });
  });

  describe('mergePrices', () => {
    it('returns 7 rows for 5 sahkotin (h0–h4) + 5 nordpool (h2–h6)', () => {
      const base = new Date('2026-01-01T00:00:00.000Z').getTime();
      const h = function (n) { return new Date(base + n * 3600000); };

      const sahkotinRows = [0, 1, 2, 3, 4].map(function (n) {
        return { validAt: h(n), priceCKwh: 10 + n, source: 'sahkotin' };
      });
      const nordpoolRows = [2, 3, 4, 5, 6].map(function (n) {
        return { validAt: h(n), priceCKwh: 20 + n, source: 'nordpool-predict' };
      });

      const merged = mergePrices(sahkotinRows, nordpoolRows);
      assert.strictEqual(merged.length, 7, 'expected 7 rows');

      // h0–h4 must be sahkotin
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(merged[i].source, 'sahkotin', 'h' + i + ' should be sahkotin');
      }
      // h5–h6 must be nordpool-predict
      assert.strictEqual(merged[5].source, 'nordpool-predict', 'h5 should be nordpool-predict');
      assert.strictEqual(merged[6].source, 'nordpool-predict', 'h6 should be nordpool-predict');

      // sorted ascending
      for (let j = 1; j < merged.length; j++) {
        assert.ok(merged[j].validAt >= merged[j - 1].validAt, 'not sorted at index ' + j);
      }
    });
  });

  describe('fetchPrices (live network)', () => {
    const skip = process.env.RUN_LIVE_NETWORK_TESTS !== '1';
    it('returns at least 12 rows with valid structure' + (skip ? ' [SKIPPED]' : ''), { skip }, async () => {
      const rows = await fetchPrices({ horizonHours: 24 });
      assert.ok(rows.length >= 12, 'expected at least 12 rows, got ' + rows.length);
      rows.forEach(function (r, i) {
        assert.ok(r.validAt instanceof Date, 'row ' + i + ' validAt not a Date');
        assert.ok(typeof r.priceCKwh === 'number', 'row ' + i + ' priceCKwh not a number');
        assert.ok(r.source === 'sahkotin' || r.source === 'nordpool-predict',
          'row ' + i + ' unknown source: ' + r.source);
      });
    });
  });
});
