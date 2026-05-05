'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const versionMod = require('../server/lib/forecast/version.js');

describe('forecast/version', () => {
  it('exports an 8-char hex ALGORITHM_VERSION at module load', () => {
    assert.match(versionMod.ALGORITHM_VERSION, /^[0-9a-f]{8}$/);
  });

  it('lists shelly/control-logic.js and energy-balance.js as extra sources', () => {
    const extras = versionMod._EXTRA_SOURCES;
    assert.ok(extras.some(p => p.endsWith(path.join('shelly', 'control-logic.js'))),
      'expected shelly/control-logic.js in extras: ' + JSON.stringify(extras));
    assert.ok(extras.some(p => p.endsWith(path.join('server', 'lib', 'energy-balance.js'))),
      'expected server/lib/energy-balance.js in extras: ' + JSON.stringify(extras));
  });

  describe('_compute(dir, extras) — controlled file set', () => {
    let tmpDir;
    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-version-'));
      fs.writeFileSync(path.join(tmpDir, 'a.js'), 'module.exports = 1;');
      fs.mkdirSync(path.join(tmpDir, 'sub'));
      fs.writeFileSync(path.join(tmpDir, 'sub', 'b.js'), 'module.exports = 2;');
    });
    after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('returns the same digest for identical content', () => {
      const v1 = versionMod._compute(tmpDir, []);
      const v2 = versionMod._compute(tmpDir, []);
      assert.equal(v1, v2);
    });

    it('changes when ANY file in the dir changes', () => {
      const before = versionMod._compute(tmpDir, []);
      fs.writeFileSync(path.join(tmpDir, 'sub', 'b.js'), 'module.exports = 3;');
      const after = versionMod._compute(tmpDir, []);
      assert.notEqual(before, after);
    });

    it('changes when an extra source changes', () => {
      const extra = path.join(tmpDir, 'extra.js');
      fs.writeFileSync(extra, 'extras=1');
      const v1 = versionMod._compute(tmpDir, [extra]);
      fs.writeFileSync(extra, 'extras=2');
      const v2 = versionMod._compute(tmpDir, [extra]);
      assert.notEqual(v1, v2);
    });

    it('does NOT change when an unrelated file outside the dir + extras changes', () => {
      // Whole point of the directory-scoped hash: edits to docs, tests,
      // unrelated server files must not bump the version.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-other-'));
      try {
        const stranger = path.join(outside, 'docs.md');
        fs.writeFileSync(stranger, 'hello');
        const before = versionMod._compute(tmpDir, []);
        fs.writeFileSync(stranger, 'goodbye');
        const after = versionMod._compute(tmpDir, []);
        assert.equal(before, after);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('changes when a file is renamed (path bytes are part of the hash)', () => {
      // A rename without a content edit is still a meaningful structural
      // change — the version should bump so an operator can tell.
      const v1 = versionMod._compute(tmpDir, []);
      fs.renameSync(path.join(tmpDir, 'sub', 'b.js'), path.join(tmpDir, 'sub', 'b-renamed.js'));
      const v2 = versionMod._compute(tmpDir, []);
      assert.notEqual(v1, v2);
    });
  });
});
