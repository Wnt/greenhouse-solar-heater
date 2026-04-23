import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate } from './simulator.mjs';
import { scenarios } from './scenarios.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

describe('simulation', () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const trace = simulate(scenario, scenario.config || null);

      const failures = [];
      for (const assertion of scenario.assertions) {
        try {
          assertion.check(trace);
        } catch (err) {
          failures.push(assertion.description + ': ' + err.message);
        }
      }

      if (failures.length > 0) {
        // Dump trace on failure
        if (!fs.existsSync(OUTPUT_DIR)) {
          fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }
        const tracePath = path.join(OUTPUT_DIR, scenario.name + '.trace.json');
        fs.writeFileSync(tracePath, JSON.stringify(trace, null, 2));
        assert.fail(
          failures.length + ' assertion(s) failed for ' + scenario.name +
          ':\n  - ' + failures.join('\n  - ') +
          '\n  Trace written to: ' + tracePath
        );
      }
    });
  }
});
