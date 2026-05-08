#!/usr/bin/env node
// scripts/backfill-historical-forecasts.mjs
//
// One-shot backfill of weather_forecasts and forecast_predictions for
// the existing sensor_readings_30s window, using Open-Meteo's
// historical-forecast API (https://historical-forecast-api.open-meteo.com).
// FMI's open-data WFS only exposes the current model run, so direct
// FMI backfill isn't possible; Open-Meteo's archive returns the model
// values that *would* have been forecast for past dates.
//
// Two passes:
//   1. Pull Open-Meteo hourly forecast values for the window and
//      upsert into weather_forecasts. fetched_at is synthesised as
//      valid_at − 24 h so the row reads as a "1-day-ahead" forecast
//      for joins; the new prediction-capture pipeline writing real
//      multi-fetched_at rows takes over going forward.
//   2. Walk every HH:30 in the window, snapshot tank+greenhouse state
//      from sensor_readings_30s, fit coefficients from data available
//      up to that point, run the forecast engine, and upsert all 48
//      horizon rows into forecast_predictions.
//
// Usage:
//   DATABASE_URL=postgres://… node scripts/backfill-historical-forecasts.mjs
//
// Idempotent. Re-run safely; ON CONFLICT DO UPDATE handles re-fills.
//
// Optional flags:
//   --weather-only   skip the prediction retro-run (pass 1 only).
//   --start=YYYY-MM-DD  override the start of the backfill window.
//   --end=YYYY-MM-DD    override the end.
//   --dry-run        print row counts but skip DB writes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot  = path.resolve(__dirname, '..');

// ─── CLI parsing ──────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {
  weatherOnly: argv.includes('--weather-only'),
  dryRun:      argv.includes('--dry-run'),
  start:       argv.find(a => a.startsWith('--start='))?.slice(8) || null,
  end:         argv.find(a => a.startsWith('--end='))?.slice(6) || null,
};

// ─── system.yaml lat/lon ──────────────────────────────────────
const yamlLib = await import(path.join(repoRoot, 'scripts/lib/yaml-load.js'));
const sys = yamlLib.load(fs.readFileSync(path.join(repoRoot, 'system.yaml'), 'utf8'));
const lat = sys.location?.lat;
const lon = sys.location?.lon;
if (!lat || !lon) { console.error('system.yaml missing location.lat/lon'); process.exit(1); }

// ─── DB connection ────────────────────────────────────────────
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL env var required'); process.exit(1); }
// Accept sslmode=no-verify (set by the local-dev-via-tunnel recipe);
// pg's parser doesn't grok that value, strip it and rely on env.
const cleanUrl = url.replace(/[?&]sslmode=[^&]*/g, '');
const pool = new pg.Pool({
  connectionString: cleanUrl,
  ssl: url.includes('sslmode=') ? { rejectUnauthorized: false } : false,
});

// ─── Open-Meteo fetch ─────────────────────────────────────────
function getJson(u) {
  return new Promise((resolve, reject) => {
    https.get(u, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${u}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchOpenMeteo(startDate, endDate) {
  const params = new URLSearchParams({
    latitude:  String(lat),
    longitude: String(lon),
    hourly: [
      'temperature_2m', 'relative_humidity_2m', 'dew_point_2m',
      'precipitation', 'cloud_cover', 'shortwave_radiation',
      'wind_speed_10m', 'wind_gusts_10m', 'surface_pressure',
    ].join(','),
    start_date: startDate,
    end_date:   endDate,
    timezone:   'UTC',
    wind_speed_unit: 'ms',  // request m/s instead of default km/h
  });
  const url = 'https://historical-forecast-api.open-meteo.com/v1/forecast?' + params.toString();
  console.log(`[backfill] GET ${startDate}..${endDate}`);
  return getJson(url);
}

// ─── window resolution ────────────────────────────────────────
async function windowFromActuals() {
  const r = await pool.query(
    "SELECT min(bucket) AS min_b, max(bucket) AS max_b FROM sensor_readings_30s"
  );
  const minB = r.rows[0].min_b;
  const maxB = r.rows[0].max_b;
  if (!minB) throw new Error('sensor_readings_30s is empty');
  return { startDate: ymd(minB), endDate: ymd(maxB) };
}

function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// ─── Pass 1: weather backfill ─────────────────────────────────
async function backfillWeather(startDate, endDate) {
  const data = await fetchOpenMeteo(startDate, endDate);
  const times = data.hourly.time;          // ['2026-04-25T00:00', …]
  const t   = data.hourly.temperature_2m;
  const rh  = data.hourly.relative_humidity_2m;
  const dp  = data.hourly.dew_point_2m;
  const pr  = data.hourly.precipitation;
  const cc  = data.hourly.cloud_cover;
  const sr  = data.hourly.shortwave_radiation;
  const ws  = data.hourly.wind_speed_10m;
  const wg  = data.hourly.wind_gusts_10m;
  const sp  = data.hourly.surface_pressure;

  const rows = times.map((ts, i) => {
    const validAt = new Date(ts + 'Z'); // input is UTC
    const fetchedAt = new Date(validAt.getTime() - 24 * 3600 * 1000);
    return {
      fetchedAt, validAt,
      temperature: t[i], radiationGlobal: sr[i],
      windSpeed: ws[i], precipitation: pr[i],
      humidity: rh[i], dewPoint: dp[i],
      cloudCover: cc[i], windGust: wg[i],
      pressure: sp[i],
    };
  });

  console.log(`[backfill] weather rows to upsert: ${rows.length}`);
  if (flags.dryRun) return;

  const sql =
    'INSERT INTO weather_forecasts ' +
    '(fetched_at, valid_at, temperature, radiation_global, wind_speed, precipitation, ' +
    ' humidity, dew_point, cloud_cover, wind_gust, pressure) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ' +
    'ON CONFLICT (fetched_at, valid_at) DO UPDATE SET ' +
    '  temperature = EXCLUDED.temperature, ' +
    '  radiation_global = EXCLUDED.radiation_global, ' +
    '  wind_speed = EXCLUDED.wind_speed, ' +
    '  precipitation = EXCLUDED.precipitation, ' +
    '  humidity = EXCLUDED.humidity, ' +
    '  dew_point = EXCLUDED.dew_point, ' +
    '  cloud_cover = EXCLUDED.cloud_cover, ' +
    '  wind_gust = EXCLUDED.wind_gust, ' +
    '  pressure = EXCLUDED.pressure';

  let done = 0;
  for (const r of rows) {
    await pool.query(sql, [
      r.fetchedAt, r.validAt, r.temperature, r.radiationGlobal,
      r.windSpeed, r.precipitation, r.humidity, r.dewPoint,
      r.cloudCover, r.windGust, r.pressure,
    ]);
    done++;
    if (done % 100 === 0) process.stdout.write(`\r[backfill] weather ${done}/${rows.length}`);
  }
  process.stdout.write(`\r[backfill] weather ${done}/${rows.length}\n`);
}

// ─── Pass 2: retro-run engine ─────────────────────────────────
async function backfillPredictions(startDate, endDate) {
  const { computeSustainForecast } = await import(path.join(repoRoot, 'server/lib/forecast/sustain-forecast.js'));
  const { fitEmpiricalCoefficients } = await import(path.join(repoRoot, 'server/lib/forecast/sustain-forecast-fit.js'));
  const { ALGORITHM_VERSION } = await import(path.join(repoRoot, 'server/lib/forecast/version.js'));

  // Walk every HH:30 in the window.
  const startMs = new Date(startDate + 'T00:30:00Z').getTime();
  const endMs   = new Date(endDate   + 'T23:30:00Z').getTime();

  const captures = [];
  for (let t = startMs; t <= endMs; t += 3600 * 1000) captures.push(new Date(t));
  console.log(`[backfill] HH:30 capture timestamps: ${captures.length}`);

  let written = 0;
  for (const genAt of captures) {
    const rows = await captureAt(genAt, computeSustainForecast, fitEmpiricalCoefficients, ALGORITHM_VERSION);
    if (rows && rows.length > 0) {
      written += await persistPredictionRows(rows);
      if (written % 480 === 0) process.stdout.write(`\r[backfill] predictions ${written}`);
    }
  }
  process.stdout.write(`\r[backfill] predictions ${written}\n`);
}

async function captureAt(genAt, computeSustainForecast, fitEmpiricalCoefficients, ALGORITHM_VERSION) {
  // 1) initial state from sensor_readings_30s within ±5 min
  const tankTop    = await sensorAt('tank_top',    genAt, 5);
  const tankBottom = await sensorAt('tank_bottom', genAt, 5);
  const ghTemp     = await sensorAt('greenhouse',  genAt, 5);
  if (tankTop === null || tankBottom === null || ghTemp === null) return null;

  // 2) current mode at genAt
  const modeRow = await pool.query(
    "SELECT new_value FROM state_events " +
    "WHERE entity_type='mode' AND ts <= $1 ORDER BY ts DESC LIMIT 1",
    [genAt]
  );
  const currentMode = modeRow.rows[0]?.new_value || 'idle';

  // 3) weather + prices for next 48 h relative to genAt
  const weather48h = await fetchWeatherFor(genAt, 48);
  const prices48h  = await fetchPricesFor(genAt, 48);
  if (weather48h.length === 0) return null;

  // 4) coefficients fit from history available up to genAt
  // For backfill simplicity, we re-fit per capture using up to 14 d of
  // history before genAt. This mirrors the live engine's 14-day window.
  const history = await fetchHistoryUpTo(genAt, 14);
  const coefficients = fitEmpiricalCoefficients(history);

  // 5) run engine
  const fc = computeSustainForecast({
    now: genAt, tankTop, tankBottom, greenhouseTemp: ghTemp,
    currentMode,
    weather48h, prices48h, coefficients,
    config: { weatherFetchedAt: genAt },
  });

  // 6) build rows in same shape as forecast-predictions.js buildRows
  return buildPredictionRows({
    generatedAt: genAt.toISOString(),
    forecast: fc, weather: weather48h, prices: prices48h,
    coefficients, algorithmVersion: ALGORITHM_VERSION,
  });
}

async function sensorAt(sensorId, at, plusMinusMin) {
  const r = await pool.query(
    'SELECT avg_value FROM sensor_readings_30s ' +
    "WHERE sensor_id = $1 AND bucket BETWEEN ($2::timestamptz - INTERVAL '" + plusMinusMin + " min') " +
    "                                AND ($2::timestamptz + INTERVAL '" + plusMinusMin + " min') " +
    'ORDER BY ABS(EXTRACT(EPOCH FROM (bucket - $2::timestamptz))) LIMIT 1',
    [sensorId, at]
  );
  return r.rows[0]?.avg_value ?? null;
}

async function fetchWeatherFor(genAt, hours) {
  // Use whatever weather_forecasts has — backfilled by pass 1 already.
  const r = await pool.query(
    'SELECT DISTINCT ON (valid_at) valid_at, temperature, ' +
    '  radiation_global AS "radiationGlobal", wind_speed AS "windSpeed", ' +
    '  precipitation, humidity, dew_point AS "dewPoint", ' +
    '  cloud_cover AS "cloudCover", wind_gust AS "windGust", pressure ' +
    'FROM weather_forecasts ' +
    'WHERE valid_at >= $1::timestamptz AND valid_at <= ($1::timestamptz + INTERVAL \'' + hours + ' hours\') ' +
    'ORDER BY valid_at, fetched_at DESC',
    [genAt]
  );
  return r.rows.map(row => ({
    ts:              row.valid_at.toISOString(),
    validAt:         row.valid_at.toISOString(),
    temperature:     row.temperature,
    radiationGlobal: row.radiationGlobal,
    windSpeed:       row.windSpeed,
    precipitation:   row.precipitation,
    humidity:        row.humidity,
    dewPoint:        row.dewPoint,
    cloudCover:      row.cloudCover,
    windGust:        row.windGust,
    pressure:        row.pressure,
  }));
}

async function fetchPricesFor(genAt, hours) {
  const r = await pool.query(
    'SELECT DISTINCT ON (valid_at) valid_at, source, price_c_kwh ' +
    'FROM spot_prices ' +
    'WHERE valid_at >= $1::timestamptz AND valid_at <= ($1::timestamptz + INTERVAL \'' + hours + ' hours\') ' +
    "ORDER BY valid_at, CASE source WHEN 'sahkotin' THEN 0 ELSE 1 END, fetched_at DESC",
    [genAt]
  );
  return r.rows.map(row => ({
    ts:        row.valid_at.toISOString(),
    validAt:   row.valid_at.toISOString(),
    priceCKwh: row.price_c_kwh,
    source:    row.source,
  }));
}

async function fetchHistoryUpTo(genAt, days) {
  const sensorsR = await pool.query(
    'SELECT bucket AS ts, sensor_id, avg_value FROM sensor_readings_30s ' +
    'WHERE bucket BETWEEN ($1::timestamptz - INTERVAL \'' + days + ' days\') AND $1::timestamptz ' +
    'ORDER BY bucket',
    [genAt]
  );
  const buckets = {};
  for (const row of sensorsR.rows) {
    const k = row.ts.getTime();
    if (!buckets[k]) buckets[k] = { ts: row.ts };
    const f = { tank_top: 'tankTop', tank_bottom: 'tankBottom',
                greenhouse: 'greenhouse', outdoor: 'outdoor', collector: 'collector' }[row.sensor_id];
    if (f) buckets[k][f] = row.avg_value;
  }
  const readings = Object.keys(buckets).sort().map(k => buckets[k]);
  const modesR = await pool.query(
    "SELECT ts, new_value AS mode FROM state_events " +
    "WHERE entity_type='mode' AND ts BETWEEN ($1::timestamptz - INTERVAL '" + days + " days') AND $1::timestamptz ORDER BY ts",
    [genAt]
  );
  return { readings, modes: modesR.rows.map(r => ({ ts: r.ts, mode: r.mode })) };
}

// Same logic as forecast-predictions.js buildRows — duplicated here so
// the backfill script doesn't depend on the runtime module's internals.
function buildPredictionRows(opts) {
  const fc = opts.forecast;
  const tank = fc.tankTrajectory || [];
  const gh   = fc.greenhouseTrajectory || [];
  const cmp  = fc.componentTrajectory || [];
  const modeEntries = fc.modeForecast || [];
  if (tank.length < 2 || gh.length < 2) return null;
  const modeByTs = {};
  for (const m of modeEntries) {
    if (!modeByTs[m.ts]) modeByTs[m.ts] = { mode: 'idle', hasSolar: false, duty: null };
    const e = modeByTs[m.ts];
    if (m.mode === 'solar_charging') {
      if (e.mode === 'idle') e.mode = 'solar_charging'; else e.hasSolar = true;
    } else {
      if (e.mode === 'solar_charging') e.hasSolar = true;
      e.mode = m.mode;
      if (typeof m.duty === 'number') e.duty = m.duty;
    }
  }
  const rows = [];
  const horizon = Math.min(tank.length - 1, gh.length - 1);
  for (let h = 1; h <= horizon; h++) {
    const tankAt = tank[h]; const ghAt = gh[h];
    const startTs = tank[h - 1]?.ts;
    const me = (startTs && modeByTs[startTs]) || { mode: 'idle', hasSolar: false, duty: null };
    const c  = cmp[h - 1] || {};
    const wx = nearestRow(opts.weather, ghAt.ts);
    const px = nearestRow(opts.prices,  ghAt.ts);
    rows.push({
      generatedAt: opts.generatedAt, horizonH: h, forHour: ghAt.ts,
      mode: me.mode, hasSolarOverlay: me.hasSolar, duty: me.duty,
      tankTopC: round2(tankAt.top), tankBottomC: round2(tankAt.bottom),
      tankAvgC: round2(tankAt.avg), greenhouseC: round2(ghAt.temp),
      predSolarGainKwh: typeof c.solarGainKwh === 'number' ? c.solarGainKwh : null,
      predRadDeliveredW: typeof c.radDeliveredW === 'number' ? c.radDeliveredW : null,
      predHeaterKwh: typeof c.heaterKwh === 'number' ? c.heaterKwh : null,
      predTankLossW: typeof c.tankLossW === 'number' ? c.tankLossW : null,
      predCloudFactor: typeof c.cloudFactor === 'number' ? c.cloudFactor : null,
      outdoorC: wx?.temperature ?? null,
      radiationWm2: wx?.radiationGlobal ?? null,
      windSpeedMs: wx?.windSpeed ?? null,
      precipitationMm: wx?.precipitation ?? null,
      priceCKwh: px?.priceCKwh ?? null,
      algorithmVersion: opts.algorithmVersion,
      tu: null,
      coefficients: opts.coefficients,
    });
  }
  return rows;
}

function nearestRow(rows, targetIso) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const target = new Date(targetIso).getTime();
  let best = null; let bestDelta = Infinity;
  for (const r of rows) {
    const t = new Date(r.validAt).getTime();
    const d = Math.abs(t - target);
    if (d < bestDelta) { bestDelta = d; best = r; }
  }
  return bestDelta <= 90 * 60 * 1000 ? best : null;
}

function round2(v) { return typeof v === 'number' ? Math.round(v * 100) / 100 : v; }

async function persistPredictionRows(rows) {
  if (flags.dryRun) return rows.length;
  const cols = [
    'generated_at', 'horizon_h', 'for_hour', 'mode', 'has_solar_overlay', 'duty',
    'tank_top_c', 'tank_bottom_c', 'tank_avg_c', 'greenhouse_c',
    'pred_solar_gain_kwh', 'pred_rad_delivered_w', 'pred_heater_kwh',
    'pred_tank_loss_w', 'pred_cloud_factor',
    'outdoor_c', 'radiation_w_m2', 'wind_speed_m_s', 'precipitation_mm',
    'price_c_kwh', 'algorithm_version', 'tu', 'coefficients',
  ];
  const placeholders = []; const values = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const base = i * cols.length;
    placeholders.push('(' + cols.map((_, j) => '$' + (base + j + 1)).join(',') + ')');
    values.push(
      r.generatedAt, r.horizonH, r.forHour, r.mode, r.hasSolarOverlay, r.duty,
      r.tankTopC, r.tankBottomC, r.tankAvgC, r.greenhouseC,
      r.predSolarGainKwh, r.predRadDeliveredW, r.predHeaterKwh,
      r.predTankLossW, r.predCloudFactor,
      r.outdoorC, r.radiationWm2, r.windSpeedMs, r.precipitationMm,
      r.priceCKwh, r.algorithmVersion,
      r.tu ? JSON.stringify(r.tu) : null,
      r.coefficients ? JSON.stringify(r.coefficients) : null
    );
  }
  const updateCols = cols.filter(c => c !== 'generated_at' && c !== 'horizon_h');
  const sql =
    'INSERT INTO forecast_predictions (' + cols.join(', ') + ') VALUES ' +
    placeholders.join(', ') + ' ON CONFLICT (generated_at, horizon_h) DO UPDATE SET ' +
    updateCols.map(c => c + ' = EXCLUDED.' + c).join(', ');
  await pool.query(sql, values);
  return rows.length;
}

// ─── main ─────────────────────────────────────────────────────
async function main() {
  let startDate = flags.start;
  let endDate   = flags.end;
  if (!startDate || !endDate) {
    const w = await windowFromActuals();
    startDate = startDate || w.startDate;
    endDate   = endDate   || w.endDate;
  }
  console.log(`[backfill] window: ${startDate} → ${endDate} (lat=${lat}, lon=${lon})`);

  await backfillWeather(startDate, endDate);

  if (!flags.weatherOnly) {
    await backfillPredictions(startDate, endDate);
  }

  console.log('[backfill] done');
  await pool.end();
}

main().catch(e => { console.error('[backfill] FAILED:', e.stack || e.message); process.exit(1); });
