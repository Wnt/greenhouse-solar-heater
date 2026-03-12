const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { simulate } = require('./simulator.js');
const { scenarios } = require('./scenarios.js');

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
