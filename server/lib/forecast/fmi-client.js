'use strict';

/**
 * Minimal FMI WFS client. Fetches HARMONIE surface point forecast for one
 * lat/lon and returns hourly rows. No XML library — the BsWfsElement shape
 * is stable enough for regex extraction.
 *
 * fetchForecast({ lat, lon, hours = 48 }) → Promise<Array<{
 *   validAt: Date,
 *   temperature: number | null,       // °C
 *   radiationGlobal: number | null,   // W/m²
 *   windSpeed: number | null,         // m/s
 *   precipitation: number | null,     // mm/h
 * }>>
 */

const https = require('node:https');

const WFS_BASE = 'https://opendata.fmi.fi/wfs';
const STORED_QUERY = 'fmi::forecast::harmonie::surface::point::simple';
const PARAMETERS = 'Temperature,WindSpeedMS,Precipitation1h,RadiationGlobal';
const DEFAULT_HOURS = 48;
const TIMEOUT_MS = 10000;

// Map FMI ParameterName strings to output field names.
const PARAM_MAP = {
  Temperature: 'temperature',
  RadiationGlobal: 'radiationGlobal',
  WindSpeedMS: 'windSpeed',
  Precipitation1h: 'precipitation',
};

/**
 * Parse a WFS FeatureCollection XML body into forecast rows.
 * Exported for unit testing without HTTP.
 */
function parseWfsResponse(xml) {
  if (!xml.includes('<wfs:FeatureCollection')) {
    throw new Error('FMI fetch failed: response is not a wfs:FeatureCollection');
  }

  // Map of ISO-string → { temperature, radiationGlobal, windSpeed, precipitation }
  const rows = {};

  // Regex to find each BsWfsElement block.
  const elementRe = /<BsWfs:BsWfsElement[\s\S]*?<\/BsWfs:BsWfsElement>/g;
  const timeRe = /<BsWfs:Time>\s*([\s\S]*?)\s*<\/BsWfs:Time>/;
  const nameRe = /<BsWfs:ParameterName>\s*([\s\S]*?)\s*<\/BsWfs:ParameterName>/;
  const valueRe = /<BsWfs:ParameterValue>\s*([\s\S]*?)\s*<\/BsWfs:ParameterValue>/;

  let match;
  while ((match = elementRe.exec(xml)) !== null) {
    const block = match[0];
    const tm = timeRe.exec(block);
    const nm = nameRe.exec(block);
    const vm = valueRe.exec(block);
    if (!tm || !nm || !vm) continue;

    const timeStr = tm[1].trim();
    const paramName = nm[1].trim();
    const rawValue = vm[1].trim();

    const field = PARAM_MAP[paramName];
    if (!field) continue;

    const value = parseFloat(rawValue);
    const coerced = isNaN(value) ? null : value;

    if (!rows[timeStr]) {
      rows[timeStr] = { temperature: null, radiationGlobal: null, windSpeed: null, precipitation: null };
    }
    rows[timeStr][field] = coerced;
  }

  const result = Object.keys(rows).map(function (ts) {
    const r = rows[ts];
    return {
      validAt: new Date(ts),
      temperature: r.temperature,
      radiationGlobal: r.radiationGlobal,
      windSpeed: r.windSpeed,
      precipitation: r.precipitation,
    };
  });

  result.sort(function (a, b) { return a.validAt - b.validAt; });
  return result;
}

function buildUrl(lat, lon, hours) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 3600 * 1000);
  return (
    WFS_BASE +
    '?service=WFS&version=2.0.0&request=getFeature' +
    '&storedquery_id=' + encodeURIComponent(STORED_QUERY) +
    '&latlon=' + lat + ',' + lon +
    '&parameters=' + PARAMETERS +
    '&starttime=' + now.toISOString() +
    '&endtime=' + end.toISOString()
  );
}

function fetchForecast(opts) {
  const lat = opts.lat;
  const lon = opts.lon;
  const hours = opts.hours != null ? opts.hours : DEFAULT_HOURS;
  const url = buildUrl(lat, lon, hours);

  return new Promise(function (resolve, reject) {
    const req = https.get(url, function (res) {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('FMI fetch failed: HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const xml = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(parseWfsResponse(xml));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.setTimeout(TIMEOUT_MS, function () {
      req.destroy();
      reject(new Error('FMI fetch failed: request timed out'));
    });

    req.on('error', function (e) {
      reject(new Error('FMI fetch failed: ' + e.message));
    });
  });
}

module.exports = { fetchForecast, parseWfsResponse };
