/**
 * Drift check: the committed playground/assets/bootstrap-history.json
 * must match what `scripts/generate-bootstrap-history.mjs` produces
 * from the current shelly/control-logic.js + playground/js/physics.js.
 *
 * If you change a temperature threshold, hysteresis, or anything else
 * that affects the 12 h fast-forward output, this test fails. Fix it
 * by running `npm run bootstrap-history` and committing the updated
 * snapshot alongside your logic change — the snapshot is what the
 * GitHub Pages deploy serves on first paint, so reviewers see the
 * dashboard impact in the same diff as the threshold tweak.
 *
 * Same shape as tests/topology-diagram.test.js, which guards
 * design/diagrams/system-topology.drawio against drift from
 * system.yaml + topology-layout.yaml.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import {
  generate,
  serialize,
  OUTPUT_PATH,
} from '../scripts/generate-bootstrap-history.mjs';

describe('bootstrap-history snapshot drift', () => {
  it('committed playground/assets/bootstrap-history.json matches the generator output', () => {
    const expected = serialize(generate());

    let actual;
    try {
      actual = readFileSync(OUTPUT_PATH, 'utf8');
    } catch (err) {
      assert.fail(
        `Could not read ${OUTPUT_PATH}: ${err.message}\n` +
          'Run `npm run bootstrap-history` to generate it.'
      );
    }

    if (actual === expected) return;

    // Find the first differing line so the failure message points at
    // the actual change instead of dumping a 178 KB diff.
    const expectedLines = expected.split('\n');
    const actualLines = actual.split('\n');
    let firstDiff = -1;
    for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i++) {
      if (expectedLines[i] !== actualLines[i]) {
        firstDiff = i;
        break;
      }
    }

    const context = (lines, around) => {
      const start = Math.max(0, around - 2);
      const end = Math.min(lines.length, around + 3);
      return lines.slice(start, end).map((l, j) => `  ${start + j + 1}: ${l}`).join('\n');
    };

    assert.fail(
      'playground/assets/bootstrap-history.json is out of date.\n\n' +
        'The control logic, thermal model, or default sim params changed,\n' +
        'but the pre-baked bootstrap snapshot was not regenerated.\n\n' +
        'Fix:  npm run bootstrap-history    (then commit the updated file)\n\n' +
        `First diverging line: ${firstDiff + 1}\n` +
        '── committed (actual) ──\n' +
        context(actualLines, firstDiff) +
        '\n── generator (expected) ──\n' +
        context(expectedLines, firstDiff)
    );
  });

  it('snapshot is byte-deterministic across two generator runs', () => {
    // Sanity: the generator must not depend on Date.now/Math.random/etc.,
    // otherwise the drift test above is meaningless.
    const first = serialize(generate());
    const second = serialize(generate());
    assert.strictEqual(first, second, 'generate() must be deterministic');
  });

  it('snapshot covers the full 12 h window with at least one transition', () => {
    // Belt-and-braces: even if someone edited the JSON by hand to
    // match the generator, the data should still represent a real
    // 12 h run with at least some control activity.
    const data = generate();
    assert.strictEqual(data.meta.duration_seconds, 12 * 3600);
    assert.strictEqual(data.final_model_state.simTime, 12 * 3600);
    assert.ok(data.points.length > 0, 'expected non-empty points array');
    assert.ok(data.log_entries.length > 0, 'expected at least one mode transition');
  });
});
