/**
 * PLAYGROUND_DIR override + hot-sync version marker (preview fast path).
 * Preview pods serve the playground from a writable copy so the
 * preview-deploy workflow can sync frontend-only pushes without an
 * image rebuild; /version must then report the synced commit so the
 * open PWA shows its "new version" toast.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolvePlaygroundDir, readAppVersion, VERSION_FILE } = require('../server/lib/playground-dir');

const DEFAULT = '/app/playground';

describe('resolvePlaygroundDir', function () {
  it('uses the bundled dir when PLAYGROUND_DIR is unset', function () {
    assert.equal(resolvePlaygroundDir({}, DEFAULT), DEFAULT);
  });

  it('uses PLAYGROUND_DIR when it exists', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
    assert.equal(resolvePlaygroundDir({ PLAYGROUND_DIR: dir }, DEFAULT), path.resolve(dir));
  });

  it('falls back to the bundled dir when PLAYGROUND_DIR is missing on disk', function () {
    assert.equal(resolvePlaygroundDir({ PLAYGROUND_DIR: '/nonexistent/pg' }, DEFAULT), DEFAULT);
  });
});

describe('readAppVersion', function () {
  it('returns GIT_COMMIT when no version marker exists', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
    assert.equal(readAppVersion({ GIT_COMMIT: 'abc' }, dir), 'abc');
  });

  it('defaults to "unknown"', function () {
    assert.equal(readAppVersion({}, DEFAULT), 'unknown');
  });

  it('prefers the hot-sync marker in the playground dir', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
    fs.writeFileSync(path.join(dir, VERSION_FILE), 'def456\n');
    assert.equal(readAppVersion({ GIT_COMMIT: 'abc' }, dir), 'def456');
  });
});
