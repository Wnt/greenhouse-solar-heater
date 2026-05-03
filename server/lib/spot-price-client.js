'use strict';

/**
 * Finnish electricity spot-price client.
 * Two sources merged: confirmed prices from sahkotin.fi (incl. VAT) and
 * predicted prices from nordpool-predict-fi (excl. VAT → multiply by 1.255).
 *
 * fetchPrices({ horizonHours? }) → Promise<Array<{validAt, priceCKwh, source}>>
 */

const https = require('node:https');

const FI_VAT = 1.255; // Finnish electricity VAT multiplier (24% → 1.24... wait, 25.5%)

// Transport injectable for tests.
let _get = function (url) {
  return new Promise(function (resolve, reject) {
    function doGet(u, depth) {
      if (depth > 5) { reject(new Error('Too many redirects: ' + u)); return; }
      https.get(u, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          doGet(res.headers.location, depth + 1);
          return;
        }
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      }).on('error', reject);
    }
    doGet(url, 0);
  });
};

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Parse sahkotin.fi CSV (header + data rows).
 * CSV format: hour,price\n<ISO>,<c/kWh incl. VAT>\n…
 */
function parseSahkotinCsv(csv) {
  const rows = [];
  const lines = csv.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const ts = line.slice(0, comma).trim();
    const price = parseFloat(line.slice(comma + 1).trim());
    if (!ts || isNaN(price)) continue;
    rows.push({ validAt: new Date(ts), priceCKwh: round4(price), source: 'sahkotin' });
  }
  return rows;
}

/**
 * Parse nordpool-predict-fi JSON.
 * Format: [[ts_ms, price_c_kwh_excl_vat], …]
 * Prices are VAT-exclusive → multiply by FI_VAT.
 */
function parseNordpoolPredict(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  return data.map(function (pair) {
    return {
      validAt: new Date(pair[0]),
      priceCKwh: round4(pair[1] * FI_VAT),
      source: 'nordpool-predict',
    };
  });
}

/**
 * Merge confirmed (sahkotin) and predicted (nordpool-predict) rows.
 * Rules:
 *   – For hours where both exist, prefer sahkotin.
 *   – Use nordpool-predict only for hours strictly after the last sahkotin hour.
 *   – Drop predicted rows earlier than the first sahkotin row.
 *   – Sort ascending by validAt.
 */
function mergePrices(sahkotinRows, nordpoolRows) {
  if (!sahkotinRows.length) {
    return nordpoolRows.slice().sort(function (a, b) { return a.validAt - b.validAt; });
  }

  const lastSahkotin = sahkotinRows.reduce(function (max, r) {
    return r.validAt > max ? r.validAt : max;
  }, sahkotinRows[0].validAt);

  const firstSahkotin = sahkotinRows.reduce(function (min, r) {
    return r.validAt < min ? r.validAt : min;
  }, sahkotinRows[0].validAt);

  const merged = sahkotinRows.slice();

  nordpoolRows.forEach(function (r) {
    if (r.validAt > lastSahkotin && r.validAt >= firstSahkotin) {
      merged.push(r);
    }
  });

  return merged.sort(function (a, b) { return a.validAt - b.validAt; });
}

/**
 * Fetch and merge prices for the next horizonHours.
 */
function fetchPrices(opts) {
  const horizonHours = (opts && opts.horizonHours) || 48;
  const now = new Date();
  const start = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
  const end = new Date(start.getTime() + horizonHours * 3600000);

  const sahkotinUrl = 'https://sahkotin.fi/prices.csv?vat=true'
    + '&start=' + encodeURIComponent(start.toISOString())
    + '&end=' + encodeURIComponent(end.toISOString());
  const nordpoolUrl = 'https://raw.githubusercontent.com/vividfog/nordpool-predict-fi/main/deploy/prediction.json';

  return Promise.all([
    _get(sahkotinUrl).then(function (r) {
      if (r.statusCode >= 400) throw new Error('sahkotin HTTP ' + r.statusCode);
      return parseSahkotinCsv(r.body);
    }),
    _get(nordpoolUrl).then(function (r) {
      if (r.statusCode >= 400) throw new Error('nordpool-predict HTTP ' + r.statusCode);
      return parseNordpoolPredict(r.body);
    }),
  ]).then(function (results) {
    return mergePrices(results[0], results[1]);
  });
}

module.exports = {
  fetchPrices,
  mergePrices,
  parseSahkotinCsv,
  parseNordpoolPredict,
  _setTransport: function (fn) { _get = fn; },
};
