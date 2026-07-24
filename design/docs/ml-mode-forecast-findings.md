# ML forecast mode-selection: measured accuracy & improvement plan

*Analysis date: 2026-07-24. Data window: 2026-05-01 → 2026-07-24 (prod TimescaleDB).
Method: SQL analysis of `forecast_predictions` vs `state_events`, plus an offline
backtest of the ML engine (`scripts/backtest-mode-forecast.mjs`) replaying 104
historical episodes with as-of FMI forecasts and the live S3 model (trained 2026-07-21).*

## TL;DR

The 48 h mode schedule is produced by a hand-coded hysteresis + a fixed
`radiation ≥ 150 W/m²` solar heuristic — nothing about mode selection is learned,
and nothing in the pipeline measures it. Measured hourly dominant-mode accuracy is
**63–71% beyond 4 h, which does not beat a trivial hour-of-day climatology (71.3%)**.
The two biggest, fixable error sources: solar_charging over-prediction (the 150 W/m²
gate is too permissive — 300 W/m² is worth +3–12 pp in backtest) and a structural
inability to predict emergency_heating (0–4 predicted hours vs 56 actual in the
backtest window). All inputs needed for offline evaluation are already logged;
the one telemetry gap is that **the ML engine's forecasts are never captured** —
`forecast-bootstrap.js` only persists the physics engine's trajectory.

## What the system logs today (all confirmed usable)

| Table | Content | Fitness |
|---|---|---|
| `forecast_predictions` | Hourly (HH:30) capture of the **physics** engine's 48 h trajectory: per-horizon mode, solar overlay, duty, temps, assumed weather/price, `tu`, coefficients | ✅ enables predicted-vs-actual at any horizon. ❌ ML engine never captured |
| `state_events` (`entity_type='mode'`) | Every mode transition with cause | ✅ ground truth; 94% `automation`-caused (clean) |
| `weather_forecasts` | Every FMI fetch (`fetched_at` × `valid_at`) | ✅ true *as-of* backtests possible (no hindsight leakage) |
| `sensor_readings_30s` | 30 s aggregates, all 5 sensors | ✅ initial state + outcome verification |
| `spot_prices` | As-of Nord Pool prices | ✅ cost-forecast backtests |

## Measured results

### Logged (physics-engine) forecasts: hourly dominant-mode accuracy

| Version | h=1 | 2–3 | 4–6 | 7–12 | 13–24 | 25–48 |
|---|---|---|---|---|---|---|
| 05a78cb2 (May 27–Jun 22) | 82.4% | 73.5% | 72.2% | 72.2% | 69.6% | 69.3% |
| c4bbb846 (Jun 25–Jul 18) | 79.1% | 71.1% | 65.8% | 65.8% | 65.1% | 63.4% |
| d8ecb3c5 (Jul 18–) | 83.8% | 74.4% | 71.3% | 70.9% | 69.0% | 71.4% |
| **Persistence baseline** | 83.7% | 68.8% | 47.3% | 33.8% | 44.1% | 43.2% |
| **Hour-of-day climatology** | 71.5% | 71.6% | 71.3% | 71.3% | 71.1% | 71.3% |

Beyond ~4 h the forecast does **not** beat climatology. It does beat persistence
decisively, and near-term (h≤3) it beats both.

### Where the errors are (confusion, c4bbb846+d8ecb3c5, h>12)

Top error cells: predicted `greenhouse_heating` when actually `idle` (4,077 h),
predicted `solar_charging` when actually `idle` (2,194 h), predicted `idle` during
actual `solar_charging` (987 h). `emergency_heating`: latest version predicted **0
hours** beyond h=6 while 96–168 actual emergency hours occurred (0% recall);
c4bbb846 similar. Emergency drives the backup-cost projection, so this is the most
operationally significant miss.

### Attribution (h>12): weather input error dominates

Mode accuracy conditioned on the radiation-assumption error tercile: 71.5% (low) →
64.8% → 60.9% (high). Conditioned on greenhouse-temp error tercile: no clean
gradient (62.6/68.9/65.7). Temperature MAE: greenhouse ~2.4–2.5 °C at 13–48 h
(bias ≈ 0), tank 4.2–5.6 °C at 13–48 h; assumed-radiation MAE 60→82 W/m² with
horizon. So: the decision rule + weather uncertainty are the bottleneck, more than
the thermal model's mean error — but the ~2.4 °C greenhouse tail error is exactly
why threshold-crossing events (emergency) are missed by a point forecast.

### What the controller actually does (the target's nature)

- Median mode dwell is 6–9 min; 72–87% of dwells are <15 min (hysteresis cycling).
- 27.8% of hours have no mode occupying ≥75% of the hour.
- A single hourly mode label is therefore a lossy target with a hard accuracy
  ceiling in the mid-80s; occupancy *fractions* are the honest target.
- Mode mix is strongly seasonal (May: 23% heating hours; July: 12%; emergency
  only in May within the window) — climatology baselines must be seasonal-aware,
  and most winter behaviour is still out-of-sample for everything trained so far.
- FMI *nowcast* radiation at actual solar entries: median 421 W/m², p25 254 W/m².
  A pure radiation threshold for "solar-dominant hour" peaks around F1 78% at
  150 W/m²; conditioning on forecast `cloud_cover` made it worse in every sweep.

### Offline ML-engine backtest (104 episodes, Jun 1–Jul 22, live S3 model)

| Variant | h=1 | 2–6 | 7–24 | 25–48 |
|---|---|---|---|---|
| Engine defaults (no live tuning) | 66.3% | 60.2% | 65.5% | 62.9% |
| + live tuning (`tu` from logs) | 79.8% | 64.6% | 68.2% | 64.4% |
| + live tu, solar gate 300 W/m² | 78.8% | **76.2%** | **71.2%** | **67.7%** |
| + live tu, solar gate 450 W/m² | 76.0% | 79.0% | 69.3% | 68.5% |
| + live tu, solar gate 50 W/m² | 78.8% | 50.4% | 60.3% | 56.0% |
| Persistence / climatology (same sample) | — | — | 39.2% / 71.6% | |

Findings: (1) threshold fidelity to live tuning is worth up to +13.5 pp at h=1 —
the production handler does pass `tu`, but the engine's committed defaults
(`greenhouseEnterC: 10` vs live 16–17.5) are far from reality, so anything that
evaluates or trains against defaults is measuring a different system; (2) the
solar gate at 150 W/m² over-predicts solar (828 solar-predicted hours were
actually idle) — 300 W/m² is uniformly better for schedule accuracy at h≥2;
(3) emergency_heating was predicted 0–23 h across variants vs 56 actual hours
(≤6 hits) — a point forecast of greenhouse temperature with ~2.4 °C error cannot
see threshold crossings; (4) even the best variant only ties climatology at 25–48 h.

## Recommendations (ranked)

1. **Raise/tune the solar gate — validated, one line.** Backtest shows
   `solarChargeRadiationMinWm2: 150 → 300` gains +11.6 pp (2–6 h), +3.0 pp
   (7–24 h), +3.3 pp (25–48 h) schedule accuracy at the cost of solar recall
   (77→61%). Since `pred_solar_gain_kwh` (not the mode label) carries the energy
   estimate, the recall trade is acceptable. Re-run the sweep seasonally with the
   harness before committing a value.
2. **Capture the ML engine's forecasts.** Add an `engine` discriminator to
   `forecast_predictions` (or a parallel capture call in `forecast-bootstrap.js`
   invoking the ML handler's compute) so the *default UI engine* accrues the same
   predicted-vs-actual history the physics engine has. Without this, every future
   ML tuning decision rests on offline backtests only.
3. **Make mode-schedule quality a first-class metric.** `ml-trainer.js`'s gate is
   temperature R²/MAE only, and `forecast-diagnostics.js` serves rows without
   scoring them. Add: hourly dominant-mode accuracy vs the climatology baseline,
   solar precision/recall, and emergency-hours recall — computed in diagnostics
   (from existing tables) and asserted in the trainer gate so a model that
   degrades the *schedule* can't be promoted on better temperature MAE.
4. **Fix emergency prediction with probabilistic threshold crossing.** Instead of
   `gh_point < ehE`, estimate `P(gh < ehE)` using the residual spread the forest
   already exposes (per-tree predictions give a cheap ensemble variance; or store
   per-horizon residual quantiles from `forecast_predictions` history) and flag
   emergency when the probability exceeds ~30%. This targets the 0%-recall hole
   directly and improves the operator-facing backup-cost note, which is the
   forecast's main decision output.
5. **Predict occupancy fractions, not a single label.** The controller's 6–9 min
   dwells make hourly single-label prediction structurally lossy (ceiling ≈
   mid-80s). The feature contract already consumes mode *fractions*
   (`frac_solar_charging`, …) — emitting predicted fractions per hour (and
   rendering bands with intensity) is contract-compatible with the rollout and
   removes the false dichotomy. A learned occupancy regressor per mode (same RF
   infra, classification-via-regression) is the natural v2; train/evaluate it
   offline with the harness first.
6. **Medium-term: reuse `control-logic.js` in the rollout.** The real decision
   core is pure ES5 and already browser-loadable (`control-logic-loader.js`). The
   missing input is collector temperature — add a collector-temp forest (same
   features + radiation) and the rollout can run the *actual* entry/exit rules
   (collector-vs-tank delta, stall/drop-from-peak exit) instead of a parallel
   re-implementation that drifts (it already has: three different solar
   definitions exist across control-logic/sustain-forecast/ml-forecast).
7. **Report climatology as the skill floor.** At 25–48 h the engines tie or lose
   to hour-of-day climatology; blending toward climatology at far horizons (or at
   minimum showing it in diagnostics as the baseline) keeps the UI honest.

## Reproducing / extending

```bash
# 1. export episodes + live model from prod (kubectl context required)
node scripts/backtest-mode-forecast.mjs export --data /tmp/bt-data
# 2. run the backtest + variant sweep
node scripts/backtest-mode-forecast.mjs run --data /tmp/bt-data
node scripts/backtest-mode-forecast.mjs run --data /tmp/bt-data --solar-min 150,250,300,350
```

Caveats: summer-only data (winter regimes out-of-sample); climatology baseline is
computed in-sample (optimistic); backtest scores exclude hours with <50 min of
mode coverage; `boot`/`forced`/`safety_override` transitions (~6% of events) are
included in ground truth.
