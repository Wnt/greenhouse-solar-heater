# Quickstart: Verify Remove V_ret Valve from Collector Top

End-to-end verification workflow for feature 024. Use this after `/speckit.tasks` has produced `tasks.md` and implementation is complete, OR as a manual walkthrough to sanity-check a partial implementation. Every step has a clear pass/fail outcome.

## Prerequisites

- Git repository clean on branch `024-remove-vret-valve`.
- `npm install` has run (playground + server + linter dependencies).
- Chromium is available in `~/.cache/ms-playwright/` matching Playwright 1.56.0.
- `system.yaml`, `shelly/`, `playground/`, `server/`, `tests/`, and `design/diagrams/` all edited per the tasks.

## Steps

### 1. Baseline — capture the "before" test state

Run the full suite on `main` (or whatever branch you are rebased onto) to make sure the pre-existing tests are green. Skipping this can hide unrelated breakage.

```bash
git stash          # if you have uncommitted changes
git checkout main
npm test
git checkout 024-remove-vret-valve
git stash pop      # if you stashed
```

**Expected**: all tests green (unit + simulation + e2e), including the 023-limit-valve-operations scheduler tests and the topology drift check.

### 2. Source-of-truth regeneration

Edit `system.yaml` and `design/diagrams/topology-layout.yaml` per the tasks, then regenerate the drawio:

```bash
npm run diagram
```

**Expected**: the command emits `design/diagrams/system-topology.drawio`, exits 0, and prints no validation errors. `git diff design/diagrams/system-topology.drawio` shows only changes around the collector top (one fewer valve, one new pipe, one new reservoir port).

### 3. Topology drift check

```bash
node --test tests/topology-diagram.test.js
```

**Expected**: 1 test passes. If it fails, the committed drawio does not byte-match the generator output — re-run `npm run diagram` and commit the regenerated file.

### 4. Shelly linter

```bash
node shelly/lint/bin/shelly-lint.js shelly/control.js shelly/control-logic.js shelly/telemetry.js
```

**Expected**: zero errors. Pre-existing warnings (documented in `shelly/lint/rules/`) are acceptable but no new warnings from SH-014 or the other rules.

### 5. Shelly script size

Check that the combined `control.js` + `control-logic.js` size stays under the Shelly 16 KB limit (or, if above 16 KB, stays below the level at which commit `6c4aac2` noted it was working):

```bash
wc -c shelly/control.js shelly/control-logic.js
```

**Expected**: combined byte count slightly smaller than before the feature (removing data reduces size). If the combined size exceeds the pre-feature baseline, something went wrong in the edit.

### 6. Unit + simulation tests

```bash
npm run test:unit
```

**Expected**: all tests pass. Pay attention to:

- `tests/control-logic.test.js` — the 1000-iteration scheduler invariant fuzz must pass with 7 valves.
- `tests/control-logic.test.js` — `buildSnapshotFromState` suite must assert 7-key `valve_states`.
- `tests/control-logic.test.js` — `VALVE_NAMES_SORTED` consistency check (if present) must reflect 7 alphabetically sorted names.
- `tests/device-config-integration.test.js` — per-mode valve states must use 7 keys.
- `tests/simulation/thermal-model.test.js` — simulated valve states must use 7 keys.
- `tests/data-source.test.js`, `tests/mqtt-bridge.test.js`, `tests/playground-control.test.js` — same.

### 7. Playwright e2e tests

```bash
npm run test:e2e
```

**Expected**: all e2e tests pass, including:

- `tests/e2e/device-config.spec.js` — the UI config format → Shelly control-logic interpretation still works.
- `tests/e2e/live-mode.spec.js` — mocked WebSocket live mode still renders.
- `tests/e2e/live-display.spec.js` — schematic + history graph render real values from the live data source, now with 7-valve state.
- `tests/e2e/live-logs.spec.js` — System Logs card paginates old events (with 8-key historical rows) and new events (with 7-key rows) without errors.
- `tests/e2e/staged-valves.spec.js` — staged-valve UI renders the `opening` / `queued_opens` / `pending_closes` fields correctly with 7 valves.

### 8. Manual playground walkthrough

Start the static server and open the playground:

```bash
npx serve -l 3210 playground/
```

Open `http://localhost:3210/` and step through the views using the sidebar (desktop) or the bottom nav (mobile):

- **Status** — bento grid dashboard renders without console errors.
- **Schematic** — the 2D schematic shows the collector top with ONE motorized valve labelled `V-air (open)` (visible only in drain mode, but the label is always there). The red `V-ret → reservoir` label is GONE. A new neutral-blue path from the collector top directly to the reservoir is visible.
- **Components** — the valve list has 7 entries. No `v_ret` anywhere.
- **Controls** — the relay-control button grid has 7 buttons. The "Return" button (formerly `data-relay="v_ret"`) is GONE.
- **Device** — runtime Shelly config explanations mention 7 valves.

Browser DevTools → Console: **no errors**. Switch between views several times to exercise live/simulation toggles.

### 9. Power-loss fail-safe walkthrough (reasoning or simulation)

In `tests/simulation/thermal-model.test.js` or equivalent, verify:

1. Start from `solar_charging` mode (pump ON, `VI-btm` OPEN, `VO-coll` OPEN, `V_air` CLOSED).
2. Simulate power loss (set all relays OFF at once).
3. Expected end state:
   - All seven motorized valves close (auto-return), **except** `V_air` which opens (normally-open polarity).
   - Pump stops.
   - The siphon from the collector-top T joint down to the reservoir breaks (air enters via `V_air`).
   - The down-leg pipe volume (~0.5-1 L) drains by gravity into the reservoir.
   - The collector body remains filled.

If the simulation or unit test covering this path is new to this feature, confirm it is included in `tests.md` and green.

### 10. Grep check (SC-001)

Case-insensitive grep for every `v_ret` spelling across the edit surface:

```bash
# Expect ZERO matches in edit-surface files
grep -riE "v_?ret" system.yaml shelly/ playground/ server/ tests/ design/diagrams/ design/docs/ CLAUDE.md \
  --exclude-dir=node_modules \
  --exclude-dir=screenshots \
  --exclude="*.dtmp"
```

**Expected**: zero matches. If any match appears:

- In `design/docs/superpowers/specs/**` or `specs/010-…` through `specs/023-…` → acceptable, historical.
- Anywhere else → bug, fix and re-run.

### 11. Screenshot regeneration (final)

```bash
npm run screenshots
```

**Expected**: `playground/screenshots/*` updated. Commit them in the final feature commit. Visual inspection of the regenerated Schematic screenshot should confirm the 7-valve layout.

### 12. Commit and push

After every step is green and all edits are staged:

```bash
git status
git add -A
git commit -m "Remove V_ret valve from collector top — 7-valve topology"
git push
```

### 13. CI verification

Push triggers GitHub Actions:

- `.github/workflows/ci.yml` — full test suite.
- `.github/workflows/lint-shelly.yml` — Shelly linter.
- `.github/workflows/deploy-pages.yml` — playground deploy to GitHub Pages.

Confirm all workflows green before claiming the feature complete.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Topology drift check fails | Forgot to run `npm run diagram` after editing `topology-layout.yaml`. |
| `tests/control-logic.test.js` scheduler fuzz fails | `VALVE_NAMES_SORTED` not alphabetical, or `MODE_VALVES` out of sync. |
| Playground schematic shows broken SVG | Edited the wrong `<path>` element in `buildSchematic()`. |
| Shelly linter fails with SH-014 | You introduced a `.sort()` or similar call instead of editing data in place. |
| Server broadcasts still contain `v_ret` | You forgot to redeploy the Shelly script — the monitoring server forwards whatever the device publishes. |
| Old System Logs rows render as `undefined` | `playground/js/main.js` iterates `valveNames` but the row's snapshot has a key not in `valveNames`. Iterate the snapshot's own keys when rendering historical rows, not the hard-coded `valveNames`. |

## Done criteria

All 13 steps complete, `npm test` green, screenshots regenerated, branch pushed, CI green. SC-001 through SC-009 from `spec.md` satisfied.
