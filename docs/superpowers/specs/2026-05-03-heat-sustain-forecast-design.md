# 48 h Tank Sustain Forecast — Design

**Status:** Draft for review
**Date:** 2026-05-03
**Branch:** `claude/heat-sustain-forecast`

## Goal

Show on the Status view, in one glance, **how long the tank's stored heat will last**, **how much electric backup heating will be needed**, and **what that backup will cost**, for the next 48 hours. Ground the prediction in:

- Current tank state (`tank_top`, `tank_bottom`, current mode).
- Empirical leakage / heating-draw rates fit from the past 14 days of our own data.
- FMI 48 h forecast (temperature, global radiation, wind, precipitation) for Kaarina.
- Finnish day-ahead spot prices + 5 c/kWh transfer fee.

A secondary, equally important goal: **start tracking weather and spot-price data now**, even before the prediction model is fully tuned, so we accumulate the data needed to validate and improve it.

## Non-goals (v1)

- Backtesting harness comparing predicted vs actual tank trajectory (follow-up).
- Cost-optimization recommendations ("shift charging to cheap hours") — display only.
- Push notifications when tank is about to run out (follow-up).
- Tuning the existing physics simulator in `playground/js/physics.js` — the simulator is unchanged; the forecast uses its own empirical model.

## Architecture

```
┌─────────────────────┐  cron 30 min   ┌─────────────────────┐
│ FMI WFS (HARMONIE)  │ ───────────►   │ weather_forecasts   │
└─────────────────────┘                │ TimescaleDB table    │
                                       └──────────┬──────────┘
┌─────────────────────┐  cron 30 min              │
│ sahkotin.fi prices  │ ───────────►   ┌──────────┴──────────┐
│ + nordpool-predict  │                │ spot_prices          │
└─────────────────────┘                │ TimescaleDB table    │
                                       └──────────┬──────────┘
                                                  │
                       ┌──────────────────────────┴───────────────────┐
                       │ GET /api/forecast                            │
                       │ ┌──────────────────────────────────────────┐ │
                       │ │ sustain-forecast.js (pure function)      │ │
                       │ │  – fits leakage W/K from past 14 d       │ │
                       │ │  – fits greenhouse-load from past 14 d   │ │
                       │ │  – projects tank top/bottom 48 h ahead   │ │
                       │ │  – computes electric kWh + EUR cost      │ │
                       │ └──────────────────────────────────────────┘ │
                       └──────────┬───────────────────────────────────┘
                                  │
                       ┌──────────┴──────────┐
                       │ playground/js/      │ ◄─ sync registry
                       │   forecast.js       │   (resume / focus / online)
                       └──────────┬──────────┘
                                  │
                       ┌──────────┴──────────┐
                       │ Status view card    │
                       │ "Next 48 h"         │
                       └─────────────────────┘
```

## Server side

### New tables (TimescaleDB)

Both new hypertables live alongside `sensor_readings` / `state_events` in `server/lib/db-schema.js`:

```sql
CREATE TABLE weather_forecasts (
  fetched_at  TIMESTAMPTZ NOT NULL,    -- when we asked FMI
  valid_at    TIMESTAMPTZ NOT NULL,    -- forecast hour
  temperature DOUBLE PRECISION,        -- °C, 2 m air
  radiation_global DOUBLE PRECISION,   -- W/m², global solar radiation
  wind_speed  DOUBLE PRECISION,        -- m/s
  precipitation DOUBLE PRECISION,      -- mm/h
  PRIMARY KEY (fetched_at, valid_at)
);
SELECT create_hypertable('weather_forecasts', 'valid_at', if_not_exists => true);

CREATE TABLE spot_prices (
  fetched_at TIMESTAMPTZ NOT NULL,
  valid_at   TIMESTAMPTZ NOT NULL,     -- hour the price applies to
  source     TEXT NOT NULL,            -- 'sahkotin' or 'nordpool-predict'
  price_c_kwh DOUBLE PRECISION NOT NULL, -- € cents per kWh, incl. VAT
  PRIMARY KEY (valid_at, source)
);
SELECT create_hypertable('spot_prices', 'valid_at', if_not_exists => true);
```

Retention: weather_forecasts pruned at 30 d (we keep enough for validation); spot_prices kept indefinitely (small, useful for historical cost analysis). Both follow the same "no aggregate cleanup" rule from `CLAUDE.md` — only raw forecasts are pruned.

### `server/lib/fmi-client.js`

Hand-written WFS client following the in-tree-protocol-clients precedent (`s3-client`, `web-push`, `ws-server`). We only call **one** stored query (`fmi::forecast::harmonie::surface::point::simple`) with one fixed lat/lon, so:

- HTTP GET to `https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature&storedquery_id=fmi::forecast::harmonie::surface::point::simple&latlon=60.41,22.37&parameters=Temperature,WindSpeedMS,Precipitation1h,RadiationGlobal&starttime=…&endtime=…`
- Targeted regex parser pulling `BsWfsElement` `Time` / `ParameterName` / `ParameterValue` triples (no XML library; the response shape is stable and trivially regex-able). Same pattern, same rationale as the in-tree S3 client.
- Returns `[{validAt, temperature, radiationGlobal, windSpeed, precipitation}]`.

If FMI returns 5xx or times out, we log + skip that cycle (latest stored forecast remains valid for up to ~6 h).

### `server/lib/spot-price-client.js`

Two sources, merged:

1. **Confirmed prices**: GET `https://sahkotin.fi/prices.csv?vat=true&start=…&end=…`. Returns hourly CSV `hour,price` with `price` in c/kWh incl. VAT. Today + tomorrow (after ~14:00 EET) covered.
2. **Predicted prices**: GET `https://raw.githubusercontent.com/vividfog/nordpool-predict-fi/main/deploy/prediction.json`. JSON `[[ts_ms, c_per_kwh], …]`, ~7 days forward.

Merge rule: prefer confirmed for hours where both exist; fall back to prediction only for hours after the last confirmed price. Stored with `source` = `'sahkotin'` or `'nordpool-predict'` so we can audit later.

### Cron / refresh loop

A new `server/lib/forecast-refresher.js` schedules:

- FMI weather: every 30 min on a `setInterval`.
- Spot prices: every 30 min between 13:00–17:00 EET (Nord Pool publishes around 14:00 EET, retry hourly until tomorrow's confirmed prices land); once daily otherwise.

`PREVIEW_MODE=true` skips both fetches (preview pods stay passive observers, per `CLAUDE.md`).

### `server/lib/sustain-forecast.js` — the engine

Pure function `computeSustainForecast({ now, tankTop, tankBottom, currentMode, history, weather48h, prices48h, config })`. No I/O. Fully unit-testable. Returns:

```js
{
  generatedAt: '2026-05-03T20:30:00Z',
  horizon: '48h',
  tankTrajectory: [{ ts, top, bottom }],          // hourly, 48 entries
  hoursUntilFloor: 17.5,                          // until avg tank < 12 °C (heating floor)
  electricKwh: 8.4,                               // sum of space-heater hours × 1 kW
  electricCostEur: 1.21,                          // sum of those hours × (price + transfer)
  costBreakdown: [{ ts, kWh, priceCKwh, eur }],   // hourly, only hours where heater on
  notes: ['Tomorrow afternoon forecast: 6 h of solar charging, +12 kWh.'],
  modelConfidence: 'medium',                      // high|medium|low based on history fit residual
}
```

**Model:**

- A separate helper `fitEmpiricalCoefficients(history)` (in `sustain-forecast.js`, also pure) is invoked by the route handler with the past 14 days of `sensor_readings_30s` + `state_events` and returns:
  - `tankLeakageWPerK` — slope of `dTank/dt` vs `(tankAvg − greenhouse)` in idle mode (no charge, no heating).
  - `greenhouseLossWPerKWind(wind)` — `dGreenhouse/dt` vs `(greenhouse − outdoor)`, with wind multiplier.
- These coefficients are passed into `computeSustainForecast` via `config.coefficients`. Splitting the fit out keeps the engine cheap to re-run on every forecast refresh while the fit only re-runs when underlying history changes (cached for 1 h).
- For each forecast hour:
  - Tank loses `(tankAvg − greenhouseTarget) × tankLeakageWPerK` Wh.
  - Greenhouse loses `(greenhouseTarget − forecastTemp) × loss(wind) × 3600` Wh.
  - If tank can supply that loss (`tankAvg > greenhouseTarget + Δ`), `greenhouse_heating` mode runs; tank drops further.
  - If tank can't (tankAvg ≤ floor), `space_heater` runs at 1 kW for the hour → `electricKwh += 1`.
  - Solar gain: if forecast `radiation_global > 200 W/m²` AND projected collector temp > tank_bottom + 5 K, credit `area × radiation × η × 1 h` to tank. Collector area + η taken from `system.yaml` (existing) or sensible default.
- Cost: `electricCostEur += 1 kWh × (priceCKwh + 5 c/kWh transfer) / 100`.

`greenhouseTarget` defaults to the existing greenhouse-heating setpoint from `shelly/control-logic.js` so the model stays aligned with the actual controller.

### `GET /api/forecast`

Returns the freshest `weather_forecasts` rows (latest `fetched_at` per `valid_at`), the merged `spot_prices`, and the engine output. Cached for 60 s in-process to avoid redundant fits on rapid client refresh.

### Authorization

Read-only for any authenticated user (admin or readonly). No mutating endpoints in this feature.

## Client side

### `playground/js/forecast.js`

Module owns the "Next 48 h" status card. Registered with `playground/js/sync/registry.js` so it auto-refreshes on Android resume / focus / network recovery, per the framework guidance in `playground/js/sync/README.md`.

### Status view card layout

```
┌──────────────────────────────────────────────────────────┐
│  Next 48 h                                               │
│                                                          │
│  Tank lasts        Backup heat       Backup cost         │
│  ~17 h             8.4 kWh           €1.21               │
│                                                          │
│  ▁▂▄▆▇█▇▆▄▃▂▁     [collapsed sparkline of tank temp]     │
│                                                          │
│  Tomorrow afternoon: 6 h of solar charging, +12 kWh.     │
│                                                          │
│  [tap to expand]                                         │
└──────────────────────────────────────────────────────────┘
```

Tap-to-expand reveals a stacked area chart (uses the existing chart helpers from `playground/js/main/`) with three traces over the 48 h window:

- Predicted **tank average temp** (filled area).
- **Space-heater hours** (red marks at the bottom, one per hour the heater is projected to run).
- **Spot price** (line overlay, secondary axis, coloured by source — solid for confirmed, dashed for predicted).

### Placement

Top of the Status view scroll, **above** the existing energy-balance card. Card fits on the visible viewport on mobile so the headline numbers are visible without scrolling.

## Configuration additions

`system.yaml` gains:

```yaml
location:
  city: Kaarina
  lat: 60.41
  lon: 22.37

space_heater:
  # existing fields preserved
  assumed_continuous_power_kw: 1   # used by sustain forecast; lower = conservative cost estimate

electricity:
  transfer_fee_c_kwh: 5            # added on top of spot price
```

These get exposed to the server via the existing `system.yaml` loader.

## Testing

- `tests/sustain-forecast.test.js` — unit tests for `sustain-forecast.js`: deterministic fixtures (synthetic weather + prices + history), assert engine outputs.
- `tests/fmi-client.test.js` — fixture-based parsing of a saved FMI WFS XML response.
- `tests/spot-price-client.test.js` — fixture-based CSV + JSON parsing, merge rule.
- `tests/forecast-refresher.test.js` — fake-timer test that the cron schedule fires correctly and respects `PREVIEW_MODE`.
- `tests/frontend/forecast-card.spec.js` — Playwright test that the card renders the three headline numbers from a mocked `/api/forecast` response and that tap expands the chart.

Frontend coverage: the new `forecast.js` module must clear ≥ 50 % statement coverage, per the `CLAUDE.md` gate.

## Drift / generated files

No new generated files. `system.yaml` additions are read directly; no new diagram regenerations needed (the topology is unchanged).

## Open follow-ups (explicitly out of scope for v1)

1. Backtesting: write a script that replays the last N days through the engine and reports prediction error.
2. Per-mode price-aware control: shift discretionary charging to cheapest 4 h windows.
3. Push notification: "tank will hit floor at 04:30 — enable boost?".
4. UI: let user override `assumed_continuous_power_kw` between 1 kW / 2 kW from the Settings view.
5. Validate / replace HARMONIE with MEPS once we confirm both work for our coordinates (MEPS is the operational successor; HARMONIE used in v1 because the test query already worked).
