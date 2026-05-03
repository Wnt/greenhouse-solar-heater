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
  var rows = {};

  // Regex to find each BsWfsElement block.
  var elementRe = /<BsWfs:BsWfsElement[\s\S]*?<\/BsWfs:BsWfsElement>/g;
  var timeRe = /<BsWfs:Time>\s*([\s\S]*?)\s*<\/BsWfs:Time>/;
  var nameRe = /<BsWfs:ParameterName>\s*([\s\S]*?)\s*<\/BsWfs:ParameterName>/;
  var valueRe = /<BsWfs:ParameterValue>\s*([\s\S]*?)\s*<\/BsWfs:ParameterValue>/;

  var match;
  while ((match = elementRe.exec(xml)) !== null) {
    var block = match[0];
    var tm = timeRe.exec(block);
    var nm = nameRe.exec(block);
    var vm = valueRe.exec(block);
    if (!tm || !nm || !vm) continue;

    var timeStr = tm[1].trim();
    var paramName = nm[1].trim();
    var rawValue = vm[1].trim();

    var field = PARAM_MAP[paramName];
    if (!field) continue;

    var value = parseFloat(rawValue);
    var coerced = isNaN(value) ? null : value;

    if (!rows[timeStr]) {
      rows[timeStr] = { temperature: null, radiationGlobal: null, windSpeed: null, precipitation: null };
    }
    rows[timeStr][field] = coerced;
  }

  var result = Object.keys(rows).map(function (ts) {
    var r = rows[ts];
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
  var now = new Date();
  var end = new Date(now.getTime() + hours * 3600 * 1000);
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
  var lat = opts.lat;
  var lon = opts.lon;
  var hours = opts.hours != null ? opts.hours : DEFAULT_HOURS;
  var url = buildUrl(lat, lon, hours);

  return new Promise(function (resolve, reject) {
    var req = https.get(url, function (res) {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('FMI fetch failed: HTTP ' + res.statusCode));
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var xml = Buffer.concat(chunks).toString('utf8');
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
