#!/usr/bin/env node
// Offline backtest of the 48 h ML forecast engine's mode schedule against
// logged production history. Proves mode-logic variants can be ranked on
// real data before deploy (see design/docs/ml-mode-forecast-findings.md).
//
// Two subcommands:
//
//   export --data <dir>            Pull everything the backtest needs out of
//                                  the prod DB *through the app pod* (kubectl
//                                  context required): mode transitions, 30-min
//                                  sensor buckets, as-of FMI forecasts for the
//                                  episode grid, spot prices, logged tuning
//                                  periods, and the live S3 model artifact.
//
//   run --data <dir>               Replay computeMlForecast at each episode
//        [--solar-min 150,300]     timestamp with as-of inputs, score the
//        [--no-live-tuning]        hourly mode schedule against state_events
//        [--from/--to YYYY-MM-DD]  ground truth, and print accuracy tables
//                                  (vs persistence + hour-of-day climatology).
//
// Episodes are every 12 h at HH:30 over [--from, --to] (default
// 2026-06-01..2026-07-22). Hours with <50 min of logged mode coverage are
// excluded from scoring. The climatology baseline is computed in-sample —
// treat it as an upper bound for that baseline, not a beatable production
// competitor.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HOUR = 3600;
const HEL_OFFSET = 3 * HOUR; // Europe/Helsinki summer offset; data window is DST
const pct = x => `${(100 * x).toFixed(1)}%`;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const FROM = arg('from', '2026-06-01');
const TO = arg('to', '2026-07-22');

// ── export ────────────────────────────────────────────────────────────

// Runs inside the app pod; must only reference modules present in the image.
function podExportScript() {
  const queries = {
    transitions: `SELECT extract(epoch FROM ts)::bigint t, new_value m, cause c
      FROM state_events WHERE entity_type='mode' ORDER BY ts`,
    temps: `SELECT extract(epoch FROM time_bucket('30 minutes', bucket))::bigint t,
        sensor_id sid, round(AVG(avg_value)::numeric,2)::float v
      FROM sensor_readings_30s WHERE bucket >= '${FROM}'::date - INTERVAL '2 days'
      GROUP BY 1,2`,
    prices: `SELECT DISTINCT ON (valid_at) extract(epoch FROM valid_at)::bigint t, price_c_kwh p
      FROM spot_prices WHERE valid_at >= '${FROM}'::date - INTERVAL '2 days'
      ORDER BY valid_at, fetched_at DESC`,
    tunings: `SELECT tu::text tu, extract(epoch FROM min(generated_at))::bigint f
      FROM forecast_predictions WHERE tu IS NOT NULL GROUP BY 1 ORDER BY 2`,
    asof: `WITH tt AS (SELECT generate_series(timestamptz '${FROM} 00:30+00',
        timestamptz '${TO} 12:30+00', interval '12 hours') t)
      SELECT extract(epoch FROM tt.t)::bigint t0, extract(epoch FROM w.valid_at)::bigint t,
             w.temperature tc, w.radiation_global r, w.wind_speed w, w.precipitation p
      FROM tt, LATERAL (
        SELECT DISTINCT ON (valid_at) valid_at, temperature, radiation_global,
               wind_speed, precipitation
        FROM weather_forecasts
        WHERE fetched_at <= tt.t AND valid_at >= tt.t - interval '1 hour'
          AND valid_at < tt.t + interval '49 hours'
        ORDER BY valid_at, fetched_at DESC) w`,
  };
  return `
const zlib = require('zlib');
const db = require('/app/server/lib/db');
const { createModelStore } = require('/app/server/lib/forecast/ml/model-store');
const Q = ${JSON.stringify(queries)};
db.resolveUrl(() => {
  const pool = db.getPool();
  const out = {};
  const keys = Object.keys(Q);
  let i = 0;
  (function next() {
    if (i >= keys.length) {
      const noop = () => {};
      const store = createModelStore({ log: { info: noop, warn: noop, error: noop } });
      store.loadInitial(() => {
        out.model = store.get();
        out.modelInfo = store.getInfo();
        const b64 = zlib.gzipSync(Buffer.from(JSON.stringify(out))).toString('base64');
        process.stdout.write(b64, () => process.exit(0));
      });
      return;
    }
    const k = keys[i++];
    pool.query(Q[k], [], (e, r) => {
      if (e) { console.error('ERR ' + k + ': ' + e.message); process.exit(1); }
      out[k] = r.rows;
      console.error(k + ': ' + r.rows.length + ' rows');
      next();
    });
  })();
});`;
}

function doExport(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  console.error(`exporting ${FROM}..${TO} via app pod (this takes ~10 s)...`);
  const raw = execFileSync('kubectl', [
    'exec', '-n', 'default', 'deploy/app', '-c', 'app', '--',
    'node', '-e', podExportScript(),
  ], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
  // The app's JSON logger writes to stdout; drop its lines, keep the b64 blob.
  const b64 = raw.split('\n').filter(l => l && !l.startsWith('{')).join('');
  const data = JSON.parse(gunzipSync(Buffer.from(b64, 'base64')).toString());
  writeFileSync(path.join(dataDir, 'backtest-data.json'), JSON.stringify(data));
  console.error(`wrote ${path.join(dataDir, 'backtest-data.json')}`
    + ` (model: ${data.modelInfo.source}, trainedAt ${data.model && data.model.trainedAt})`);
}

// ── ground-truth helpers ──────────────────────────────────────────────

function buildSegments(transitions, nowSec) {
  const trans = transitions.map(r => ({ t: +r.t, m: r.m })).sort((a, b) => a.t - b.t);
  return trans.map((x, i) => ({
    s: x.t,
    e: i + 1 < trans.length ? trans[i + 1].t : nowSec,
    m: x.m,
  }));
}

function makeOccupancy(segs) {
  return (s, e) => {
    const out = {};
    let lo = 0;
    let hi = segs.length - 1;
    let first = segs.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].e > s) { first = mid; hi = mid - 1; } else lo = mid + 1;
    }
    for (let i = first; i < segs.length && segs[i].s < e; i++) {
      const ov = Math.min(segs[i].e, e) - Math.max(segs[i].s, s);
      if (ov > 0) out[segs[i].m] = (out[segs[i].m] || 0) + ov;
    }
    return out;
  };
}

function dominant(occ) {
  let mode = null;
  let secs = -1;
  let tot = 0;
  for (const m of Object.keys(occ)) {
    tot += occ[m];
    if (occ[m] > secs) { secs = occ[m]; mode = m; }
  }
  return { mode, secs, tot };
}

// ── run ───────────────────────────────────────────────────────────────

function doRun(dataDir) {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const { computeMlForecast } = require(path.join(repoRoot, 'server/lib/forecast/ml/ml-forecast.js'));
  const D = JSON.parse(readFileSync(path.join(dataDir, 'backtest-data.json'), 'utf8'));
  const nowSec = Math.floor(Date.now() / 1000);
  const useLiveTuning = !process.argv.includes('--no-live-tuning');
  const solarMins = arg('solar-min', '150,300').split(',').map(Number);

  const segs = buildSegments(D.transitions, nowSec);
  const occupancy = makeOccupancy(segs);
  const modeAt = t => {
    for (let i = segs.length - 1; i >= 0; i--) if (segs[i].s <= t) return segs[i].m;
    return null;
  };

  // Hour-of-day (Helsinki) dominant-mode climatology over the whole window.
  const climCount = {};
  const windowStart = Math.floor(Date.parse(`${FROM}T00:00:00Z`) / 1000);
  for (let t = windowStart; t + HOUR <= nowSec; t += HOUR) {
    const d = dominant(occupancy(t, t + HOUR));
    if (!d.mode || d.tot < 3000) continue;
    const hod = Math.floor(((t + HEL_OFFSET) % 86400) / HOUR);
    (climCount[hod] = climCount[hod] || {})[d.mode] = (climCount[hod][d.mode] || 0) + 1;
  }
  const clim = {};
  for (const h of Object.keys(climCount)) clim[h] = dominant(climCount[h]).mode;

  const tempBy = {};
  for (const r of D.temps) (tempBy[r.sid] = tempBy[r.sid] || {})[+r.t] = r.v;
  const tempNear = (sid, t) => {
    const b = Math.floor(t / 1800) * 1800;
    const m = tempBy[sid] || {};
    for (const c of [b, b - 1800, b + 1800]) if (m[c] != null) return m[c];
    return null;
  };
  const priceBy = {};
  for (const r of D.prices) priceBy[+r.t] = r.p;

  // Logged tuning history (compact keys → engine config names).
  const tuPeriods = (D.tunings || []).map(r => ({ f: +r.f, tu: JSON.parse(r.tu) }));
  const tuningFor = t => {
    let best = null;
    for (const p of tuPeriods) if (p.f <= t) best = p.tu;
    if (!best) return {};
    return {
      greenhouseEnterC: best.geT,
      greenhouseExitC: best.gxT,
      emergencyEnterC: best.ehE,
      emergencyExitC: best.ehX,
    };
  };

  const episodes = {};
  for (const r of D.asof) (episodes[+r.t0] = episodes[+r.t0] || {})[+r.t] = r;

  const variants = solarMins.map(v => ({
    name: `solar-min ${v}`,
    cfg: { solarChargeRadiationMinWm2: v },
  }));
  const horizonBucket = k => (k < 1 ? '01' : k < 6 ? '02-06' : k < 24 ? '07-24' : '25-48');
  const buckets = ['01', '02-06', '07-24', '25-48'];
  const blank = () => ({
    acc: {}, conf: {},
    solar: { tp: 0, fp: 0, fn: 0, tn: 0 },
    emerg: { predH: 0, actH: 0, tp: 0 },
    pers: { n: 0, ok: 0 }, clim: { n: 0, ok: 0 },
  });
  const results = Object.fromEntries(variants.map(v => [v.name, blank()]));
  let used = 0;
  let skipped = 0;

  for (const t0s of Object.keys(episodes).sort()) {
    const T = +t0s;
    const wxMap = episodes[t0s];
    const h0 = Math.floor(T / HOUR) * HOUR;
    const weather48h = [];
    let missing = 0;
    for (let k = 0; k < 48; k++) {
      const w = wxMap[h0 + k * HOUR];
      if (w) weather48h.push({ temperature: w.tc, radiationGlobal: w.r, windSpeed: w.w, precipitation: w.p });
      else { weather48h.push(null); missing++; }
    }
    for (let k = 0; k < 48; k++) {
      if (!weather48h[k]) weather48h[k] = weather48h[k - 1] || weather48h.find(Boolean);
    }
    const tankTop = tempNear('tank_top', T);
    const tankBottom = tempNear('tank_bottom', T);
    const gh = tempNear('greenhouse', T);
    const curMode = modeAt(T);
    if (missing > 5 || tankTop == null || tankBottom == null || gh == null || !curMode) {
      skipped++;
      continue;
    }
    used++;
    const prices48h = [];
    for (let k = 0; k < 48; k++) {
      const p = priceBy[h0 + k * HOUR];
      prices48h.push({ priceCKwh: typeof p === 'number' ? p : 10 });
    }

    for (const variant of variants) {
      const config = Object.assign(useLiveTuning ? tuningFor(T) : {}, variant.cfg);
      const fc = computeMlForecast({
        now: T * 1000, tankTop, tankBottom, greenhouseTemp: gh,
        currentMode: curMode,
        emergencyRecentlyActive: curMode === 'emergency_heating',
        weather48h, prices48h, model: D.model, config,
      });
      // Aggregate the multi-resolution modeForecast (5-min steps for the
      // first 4 h, hourly after) into per-hour predicted occupancy.
      const perHour = {};
      for (const e of fc.modeForecast) {
        const ts = Date.parse(e.ts) / 1000;
        const k = Math.floor((ts - T) / HOUR);
        if (k < 0 || k >= 48) continue;
        const stepSecs = (ts - T) < 4 * HOUR ? 300 : HOUR;
        (perHour[k] = perHour[k] || {})[e.mode] = (perHour[k][e.mode] || 0) + stepSecs;
      }
      const R = results[variant.name];
      for (let k = 0; k < 48; k++) {
        const ws = T + k * HOUR;
        if (ws + HOUR > nowSec - 300) break;
        const occ = occupancy(ws, ws + HOUR);
        const d = dominant(occ);
        if (!d.mode || d.tot < 3000) continue;
        const predMode = dominant(perHour[k] || { idle: HOUR }).mode || 'idle';
        const hb = horizonBucket(k);
        (R.acc[hb] = R.acc[hb] || { n: 0, ok: 0 }).n++;
        if (predMode === d.mode) R.acc[hb].ok++;
        R.conf[`${predMode}>${d.mode}`] = (R.conf[`${predMode}>${d.mode}`] || 0) + 1;
        const predSolar = perHour[k] && perHour[k].solar_charging ? 1 : 0;
        const actSolar = (occ.solar_charging || 0) > 900 ? 1 : 0;
        const cell = predSolar && actSolar ? 'tp' : predSolar ? 'fp' : actSolar ? 'fn' : 'tn';
        R.solar[cell]++;
        const predEmerg = predMode === 'emergency_heating' ? 1 : 0;
        const actEmerg = (occ.emergency_heating || 0) > 900 ? 1 : 0;
        R.emerg.predH += predEmerg;
        R.emerg.actH += actEmerg;
        if (predEmerg && actEmerg) R.emerg.tp++;
        if (variant === variants[0]) {
          R.pers.n++;
          if (modeAt(T) === d.mode) R.pers.ok++;
          const hod = Math.floor(((ws + HEL_OFFSET) % 86400) / HOUR);
          R.clim.n++;
          if (clim[hod] === d.mode) R.clim.ok++;
        }
      }
    }
  }

  console.log(`episodes used=${used} skipped=${skipped}`
    + ` | model ${D.modelInfo.source} trainedAt=${D.model.trainedAt}`
    + ` | live tuning: ${useLiveTuning}`);
  console.log('\n== Hourly dominant-mode accuracy by horizon ==');
  console.log(`variant | ${buckets.join(' | ')}`);
  for (const variant of variants) {
    const R = results[variant.name];
    const cells = buckets.map(hb => {
      const a = R.acc[hb];
      return a ? `${pct(a.ok / a.n)} (n=${a.n})` : '-';
    });
    console.log(`${variant.name} | ${cells.join(' | ')}`);
  }
  const R0 = results[variants[0].name];
  console.log(`baselines (same sample): persistence=${pct(R0.pers.ok / R0.pers.n)}`
    + ` climatology(HOD,in-sample)=${pct(R0.clim.ok / R0.clim.n)} n=${R0.pers.n}`);
  const modes = ['idle', 'solar_charging', 'greenhouse_heating', 'emergency_heating', 'active_drain'];
  console.log(`\n== Confusion, ${variants[0].name} (rows=pred, cols=actual: ${modes.join(', ')}) ==`);
  for (const p of modes) console.log(`${p}: ${modes.map(a => R0.conf[`${p}>${a}`] || 0).join(' ')}`);
  console.log('\n== Solar + emergency detection per variant ==');
  for (const variant of variants) {
    const R = results[variant.name];
    const s = R.solar;
    const prec = s.tp / ((s.tp + s.fp) || 1);
    const rec = s.tp / ((s.tp + s.fn) || 1);
    console.log(`${variant.name} | solar prec=${pct(prec)} rec=${pct(rec)}`
      + ` F1=${pct((2 * prec * rec) / ((prec + rec) || 1))}`
      + ` | emergency predH=${R.emerg.predH} actH=${R.emerg.actH} hits=${R.emerg.tp}`);
  }
}

// ── main ──────────────────────────────────────────────────────────────

const cmd = process.argv[2];
const dataDir = arg('data', null);
if (!cmd || !dataDir || !['export', 'run'].includes(cmd)) {
  console.error('usage: backtest-mode-forecast.mjs <export|run> --data <dir>'
    + ' [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--solar-min 150,300] [--no-live-tuning]');
  process.exit(2);
}
if (cmd === 'export') doExport(dataDir);
else doRun(dataDir);
