const { describe, it } = require('node:test');
const assert = require('node:assert');
const { simulate } = require('./simulator.js');
const { scenarios } = require('./scenarios.js');

describe('simulation', () => {
  it('placeholder — scenarios not yet implemented', () => {
    assert.strictEqual(scenarios.length, 0, 'add scenarios to run simulation tests');
  });

  // TODO: each scenario runs as its own test case
  // TODO: assertions checked against trace log
  // TODO: trace dumped to tests/output/ on failure
});
