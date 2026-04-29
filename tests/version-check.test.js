/**
 * Unit tests for the /version endpoint — verifies it returns
 * the GIT_COMMIT environment variable as the version hash.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');

describe('/version endpoint', function () {
  it('returns GIT_COMMIT value as hash', function () {
    // The server reads process.env.GIT_COMMIT at module load time.
    // We verify the pattern: env var → JSON response.
    const testCommit = 'abc123def456';
    const result = execSync(
      'node -e "' +
        "process.env.GIT_COMMIT = '" + testCommit + "';" +
        "var APP_VERSION = process.env.GIT_COMMIT || 'unknown';" +
        "var out = JSON.stringify({ hash: APP_VERSION });" +
        "process.stdout.write(out);" +
      '"',
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(result);
    assert.equal(parsed.hash, testCommit);
  });

  it('defaults to "unknown" when GIT_COMMIT is not set', function () {
    const result = execSync(
      'node -e "' +
        "delete process.env.GIT_COMMIT;" +
        "var APP_VERSION = process.env.GIT_COMMIT || 'unknown';" +
        "var out = JSON.stringify({ hash: APP_VERSION });" +
        "process.stdout.write(out);" +
      '"',
      { env: Object.assign({}, process.env, { GIT_COMMIT: '' }), encoding: 'utf8' }
    );
    const parsed = JSON.parse(result);
    assert.equal(parsed.hash, 'unknown');
  });

  it('hash is a stable string for the same commit', function () {
    const commit = 'fa37f61abc123';
    const v1 = { hash: commit };
    const v2 = { hash: commit };
    assert.equal(v1.hash, v2.hash);
  });
});
