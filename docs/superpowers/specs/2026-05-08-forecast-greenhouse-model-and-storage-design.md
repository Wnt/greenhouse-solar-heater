# Forecast greenhouse-model fix + multi-horizon prediction storage

Date: 2026-05-08

## Problem

Two related issues, surfaced by comparing the last ~60 hourly captures in `forecast_predictions` against `sensor_readings_30s` ground truth on prod:

1. **Greenhouse cooling is too slow.** `sustain-forecast.js` lerps GH temp toward outdoor with τ = 8 h. Reality is closer to τ ≈ 1.5–3 h (07‑05 evening: GH dropped 27.8 → 12.1 °C in 4 h while outdoor sat at ~10 °C). Effect: when forecast outdoor drops to ~10 °C, the simulated GH stays warm for too long, never crossing `geT`/`ehE`, so the projection never shows greenhouse heating or emergency mode for those hours.
2. **No solar absorption term in the GH air balance.** The `idle` and `solar_charging` branches only modulate tank state and outdoor-driven drift; nothing tracks sunlight heating the greenhouse air. Reality on a sunny noon (e.g. 2026‑05‑08 12:29 Hel, 694 W/m², outdoor 14 °C): predicted GH 12.9 °C vs actual 33 °C, an error of +20 °C. The GH curve in the forecast graph hugs outdoor instead of rising into the 30s as the user actually observes.

Tank state predictions are accurate to ±3 °C and stay correct; the model failure is localised to the greenhouse-air sub-model.

A separate but related complaint: the per-hour prediction table only stores the +1 h horizon. The user-facing forecast graph reaches 48 h ahead, and "Tank lasts 14 h" / "GH cools to 10.8 °C at 07:13" claims on multi-hour horizons are never auditable against reality. Algorithm tuning has been guesswork because the medium-horizon data simply isn't recorded.

## Goals

- Greenhouse projection that matches observed daytime peaks (saturating around vent-cap ≈ 33 °C in current conditions, higher in summer when outdoor is hot).
- Greenhouse projection that triggers heating modes early enough when outdoor cools to ~10 °C overnight.
- Per-generation, per-horizon storage of every predicted hour over the 48 h window, with the per-component breakdown that lets a future tuning pass identify which sub-model went wrong.
- All four new GH-model parameters fit empirically from history, with sensible defaults for cold-start.

## Non-goals

- Frontend changes. The existing forecast graph will render the corrected curve from the corrected engine; no UI work is in scope.
- A predicted-vs-actual diagnostic view in the playground — tracked as a separate GH follow-up.
- Sub-hour or per-refresh capture. HH:30 once-per-hour is sufficient for tuning; finer cadence is mostly redundant data.
- Migrating the existing 76 prediction rows. They cover 3 days, are all replaced by new captures within an hour, and only carry the +1 h horizon.

## Algorithm change — greenhouse heat balance

`sustain-forecast.js` currently has four mode branches (`greenhouse_heating`, `emergency_heating`, `idle`, plus `solar_charging` overlay). Each updates `newGhTemp` independently with hand-tuned formulas; only the heating branches are roughly right.

Replace the GH-air update in **all** branches with a single heat balance applied per hour:

```
ΔT_gh = (outdoor − gh)/τ_gh                  ← passive loss to outdoor
      + α_solar · radiation                   ← solar absorption through glazing
      − max(0, gh − vent_open_c)/τ_vent       ← gravity-vent saturation
      + radiator_term                         ← only during heating modes (existing logic)
      + heater_term                           ← only during emergency mode (existing logic)
```

Per-hour update: `newGhTemp = gh + ΔT_gh` (clamped at outdoor as today; clamping above is provided by the vent term, no hard ceiling).

The heating-mode branches keep their existing radiator-effectiveness and heater-fill logic; the solar + vent terms are added on top so a sunny morning during emergency heating gracefully transitions out of emergency as the air warms.

### Parameters and fit

Four new fields on the coefficients object, all fit by `sustain-forecast-fit.js` and surfaced in the persisted `coefficients` JSON:

| Field | Meaning | Fit method | Default before fit |
|---|---|---|---|
| `ghTimeConstantH` | passive cooling τ when GH < `ghVentOpenC` | linear regression of d(gh)/dt vs (outdoor − gh) over idle, no-radiation, no-heating buckets | 2.0 h |
| `ghSolarAlphaCPerWm2` | solar absorption coefficient | regression of (gh − outdoor − passive_residual) vs radiation over daytime idle/solar-charging hours, vents closed | 0.025 °C/(W/m²) |
| `ghVentOpenC` | temp at which gravity vents engage | breakpoint detection in (gh − outdoor) vs radiation; sparse-data fallback to default | 27.0 °C |
| `ghVentTauH` | cooling τ once vents open | regression as for ghTimeConstantH but on hours with gh > vent_open_c | 0.3 h |

Fit-data minimums: 24 buckets for τ_gh, 24 for α_solar, 12 for vent params. Below threshold, fall through to defaults and set `usedDefaults = true` for the affected fields (extending the existing `usedDefaults` flag from a boolean to a per-coefficient map, e.g. `{ tank: false, ghTau: true, ghSolar: false, ghVent: true }`).

### Acceptance for the algorithm change

- Synthetic overnight cooling history (gh starting at 25 °C, outdoor at 5 °C, no sun) → fit recovers τ_gh within ±20 % of the synthetic ground truth.
- Synthetic sunny-day history (radiation ramp 0→700 W/m², outdoor 15 °C) → fit recovers α_solar within ±25 %.
- 48 h forecast with outdoor dropping to 10 °C overnight enters `greenhouse_heating` within 3 h of the GH crossing geT (regression for bug 1).
- 48 h forecast with sunny noon at 700 W/m² and outdoor 15 °C predicts GH peaking ≥ 28 °C and saturating below 35 °C (regression for bug 2 and the vent cap).

## Storage change — per-horizon `forecast_predictions`

Drop the existing `forecast_predictions` table and recreate with `(generated_at, horizon_h)` PK so each HH:30 capture writes 48 rows covering the full 48 h horizon.

### Schema

```sql
DROP TABLE IF EXISTS forecast_predictions;

CREATE TABLE forecast_predictions (
  generated_at        TIMESTAMPTZ NOT NULL,
  horizon_h           SMALLINT    NOT NULL,         -- 0..47
  for_hour            TIMESTAMPTZ NOT NULL,         -- = generated_at + horizon_h hours

  -- predicted state at end of the horizon hour
  mode                TEXT        NOT NULL,
  has_solar_overlay   BOOLEAN     NOT NULL DEFAULT FALSE,
  duty                DOUBLE PRECISION,
  tank_top_c          DOUBLE PRECISION,
  tank_bottom_c       DOUBLE PRECISION,
  tank_avg_c          DOUBLE PRECISION,
  greenhouse_c        DOUBLE PRECISION,

  -- per-hour predicted components (the "why" of the state above)
  pred_solar_gain_kwh    DOUBLE PRECISION,
  pred_rad_delivered_w   DOUBLE PRECISION,
  pred_heater_kwh        DOUBLE PRECISION,
  pred_tank_loss_w       DOUBLE PRECISION,
  pred_cloud_factor      DOUBLE PRECISION,

  -- inputs the engine actually used (snapshotted, not joined — diverges
  -- from canonical weather_forecasts only when the engine interpolated
  -- or fell back, which is exactly the case we need to diagnose)
  outdoor_c           DOUBLE PRECISION,
  radiation_w_m2      DOUBLE PRECISION,
  wind_speed_m_s      DOUBLE PRECISION,
  precipitation_mm    DOUBLE PRECISION,
  price_c_kwh         DOUBLE PRECISION,

  -- model identity
  algorithm_version   TEXT,
  tu                  JSONB,
  coefficients        JSONB,

  PRIMARY KEY (generated_at, horizon_h)
);

SELECT create_hypertable('forecast_predictions', 'generated_at', if_not_exists => true);

CREATE INDEX forecast_predictions_for_hour    ON forecast_predictions (for_hour DESC);
CREATE INDEX forecast_predictions_horizon     ON forecast_predictions (horizon_h, generated_at DESC);
```

### Migration

The DROP fires unconditionally inside `SCHEMA_SQL`, before the new CREATE. Idempotent because subsequent runs find the new schema and the CREATE is `IF NOT EXISTS`. The transient prod data (76 rows, 3 days) is dropped — at 24 captures/day for 3 days the user's already seen this data; nothing downstream depends on the rows surviving.

The legacy schema's `for_hour ← generated_at + 1h` migration UPDATE in `db-schema.js` is removed; it was a one-time fix for the old single-row-per-hour shape and has no semantics under the new (generated_at, horizon_h) PK.

### `coefficients` JSON shape

```json
{
  "tankLeakageWPerK":        3.1,
  "greenhouseLossWPerK":     118,
  "solarGainKwhByHour":      [0, 0, ..., 0.42, 0.65, ..., 0],
  "ghTimeConstantH":         1.8,
  "ghSolarAlphaCPerWm2":     0.027,
  "ghVentOpenC":             27.5,
  "ghVentTauH":              0.32,
  "fitBuckets":              42,
  "usedDefaults": { "tank": false, "ghTau": false, "ghSolar": false, "ghVent": true }
}
```

### Capture flow

`forecast-predictions.js` `captureFromForecast(response, callback)` is rewritten:

- Iterate every entry in `response.forecast.modeForecast` / `tankTrajectory` / `greenhouseTrajectory`. The trajectory arrays are length-`horizon+1` (one entry per hour boundary); the prediction row for `horizon_h = h` carries the predicted state at index `h+1` and the components consumed during the simulated hour `h → h+1`.
- For solar-overlay rows (where two `modeForecast` entries share a ts), collapse to one row with `has_solar_overlay = true` (existing logic in `buildRow`, generalised across the loop).
- Resolve weather/price input snapshots per horizon hour (existing `nearestRow` helper, called per h instead of once).
- Build a 48-element array of row tuples and INSERT in a single multi-row statement; ON CONFLICT (generated_at, horizon_h) DO UPDATE so a re-run for the same generation refreshes cleanly.

To produce per-component values, `sustain-forecast.js` returns a parallel `componentTrajectory` array (length 48) carrying `{ solarGainKwh, radDeliveredW, heaterKwh, tankLossW, cloudFactor }` per simulated hour. The engine already computes these; today they're discarded after they update tank/heater accumulators.

The HH:30 scheduler in `forecast-predictions.js` is unchanged. Cadence stays 24 captures/day; row volume rises from 24/day to 1 152/day (≈ 420 k/year). At hypertable scale that's a single chunk per couple weeks — no retention policy needed.

### `listRecent` and System Logs

`listRecent` was the +1 h projection feed for the System Logs "Prediction History" section. Preserve that view by adding a `WHERE horizon_h = 1` filter to the existing query. No change to the export format.

```js
function listRecent(limit, callback) {
  const sql =
    'SELECT for_hour, generated_at, mode, has_solar_overlay, duty, ' +
    '       tank_avg_c, greenhouse_c, outdoor_c, radiation_w_m2, ' +
    '       price_c_kwh, algorithm_version, tu, coefficients ' +
    'FROM forecast_predictions ' +
    'WHERE horizon_h = 1 ' +
    'ORDER BY generated_at DESC LIMIT $1';
  ...
}
```

The System Logs export includes `coefficients` (folded into the existing tunables column or as a new "Fit" column — operator-visible because it's the most useful single-glance signal for "which model produced this prediction").

## Tests

Unit tests live alongside existing forecast specs in `tests/` (flat layout — `sustain-forecast.test.js`, `forecast-predictions.test.js`, etc.).

- **`sustain-forecast.test.js`** (extend) and a new **`sustain-forecast-gh-model.test.js`** for the heat-balance regressions:
  - τ_gh fit recovers ±20 % from synthetic overnight history.
  - α_solar fit recovers ±25 % from synthetic sunny-day history.
  - vent-cap term holds GH below 35 °C at 700 W/m² + outdoor 25 °C.
  - cold-overnight regression triggers `greenhouse_heating` within 3 h.
  - sunny-noon regression peaks GH ≥ 28 °C.
- **`forecast-predictions.test.js`** (extend):
  - One capture writes 48 rows.
  - ON CONFLICT updates (generated_at, horizon_h), not for_hour alone.
  - `listRecent` returns only horizon_h = 1 rows.
  - Component fields are populated for all 48 horizons.
- A schema-migration test (extend whichever existing test exercises `initSchema` end-to-end against pg-mem):
  - Bootstrapping into an empty DB produces the new shape.
  - Bootstrapping over a DB that already has the legacy `forecast_predictions` shape drops it and recreates the new shape; subsequent runs are no-ops.

CI gate: existing pre-push checks (`npm run lint`, `npm run knip`, `npm test`, `npm run check:file-size --strict`) cover everything.

## Risks and mitigations

- **Fit divergence on sparse data.** The GH-air sub-models can't fit with <12–24 idle hours of clean data; defaults must be sensible. Mitigation: defaults chosen from the user's reported observations (τ ≈ 2 h, α ≈ 0.025, vent ≈ 27 °C / 0.3 h) reproduce the observed dynamics within a factor of ~1.5; fit refines from there.
- **Schema rewrite under live traffic.** DROP runs at server start before the new CREATE; the MQTT bridge isn't yet bound, so no other process is reading the table mid-migration. Preview-mode pods skip schema init entirely (existing guard in `PREVIEW_MODE`).
- **Row-volume increase.** 48× the existing rate. Negligible at hypertable scale; verified by computing 420 k rows/year.
- **System Logs view regresses if the WHERE filter is wrong.** Caught by the extended `listRecent` test — assert exactly one row per generated_at when querying.

## File touch points

- `server/lib/forecast/sustain-forecast.js` — GH heat balance applied across all mode branches; component trajectory emitted alongside tank/GH trajectories.
- `server/lib/forecast/sustain-forecast-fit.js` — new fit functions for τ_gh, α_solar, ghVentOpenC, ghVentTauH; `usedDefaults` becomes a per-coefficient map.
- `server/lib/forecast/forecast-predictions.js` — `buildRow` → `buildRows` (returns 48); `captureFromForecast` writes a single multi-row INSERT; `listRecent` adds `horizon_h = 1` filter.
- `server/lib/db-schema.js` — DROP existing table, new schema, retire the off-by-one UPDATE migration.
- `tests/sustain-forecast.test.js`, `tests/forecast-predictions.test.js`, plus a new `tests/sustain-forecast-gh-model.test.js`.
