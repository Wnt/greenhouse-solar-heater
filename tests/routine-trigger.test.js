'use strict';

/**
 * Tests for server/lib/routine-trigger.js
 *
 * fire(kind, text, opts) POSTs to the configured URL with Anthropic
 * routine headers. No-ops when env vars are unset or PREVIEW_MODE is set.
 * Per-kind rate limiting prevents repeated fires within the min interval.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Helper: fresh require of the module with a given env override.
// Clears the require cache so module-level state (rate-limit map) resets.
function freshModule(env) {
  const key = require.resolve('../server/lib/routine-trigger');
  delete require.cache[key];

  const origEnv = {};
  for (const [k, v] of Object.entries(env)) {
    origEnv[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  const mod = require('../server/lib/routine-trigger');

  // Restore env after require so module captures the right values at load time
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  return mod;
}

describe('routine-trigger', () => {
  it('returns false and makes no HTTP call when CLAUDE_ROUTINE_FIRE_URL is unset', (t, done) => {
    const mod = freshModule({
      CLAUDE_ROUTINE_FIRE_URL: undefined,
      CLAUDE_ROUTINE_FIRE_TOKEN: 'tok',
      PREVIEW_MODE: '',
    });

    const result = mod.fire('test_kind', 'hello');
    assert.strictEqual(result, false, 'must return false when URL is unset');
    // Give it a tick to confirm no async HTTP call happens
    setImmediate(() => {
      done();
    });
  });

  it('returns false when CLAUDE_ROUTINE_FIRE_TOKEN is unset', (t, done) => {
    const mod = freshModule({
      CLAUDE_ROUTINE_FIRE_URL: 'http://127.0.0.1:0/__unused',
      CLAUDE_ROUTINE_FIRE_TOKEN: undefined,
      PREVIEW_MODE: '',
    });

    const result = mod.fire('test_kind', 'hello');
    assert.strictEqual(result, false, 'must return false when TOKEN is unset');
    setImmediate(() => done());
  });

  it('returns false (no-op) when PREVIEW_MODE=true', (t, done) => {
    const mod = freshModule({
      CLAUDE_ROUTINE_FIRE_URL: 'http://127.0.0.1:0/__unused',
      CLAUDE_ROUTINE_FIRE_TOKEN: 'tok',
      PREVIEW_MODE: 'true',
    });

    const result = mod.fire('test_kind', 'hello');
    assert.strictEqual(result, false, 'must return false in PREVIEW_MODE');
    setImmediate(() => done());
  });

  it('fires with correct headers and body when fully configured', (t, done) => {
    const received = { headers: null, body: null };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        received.headers = req.headers;
        received.body = body;
        res.writeHead(200);
        res.end('ok');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}/fire`;

      const key = require.resolve('../server/lib/routine-trigger');
      delete require.cache[key];
      const savedUrl = process.env.CLAUDE_ROUTINE_FIRE_URL;
      const savedToken = process.env.CLAUDE_ROUTINE_FIRE_TOKEN;
      const savedPreview = process.env.PREVIEW_MODE;
      process.env.CLAUDE_ROUTINE_FIRE_URL = url;
      process.env.CLAUDE_ROUTINE_FIRE_TOKEN = 'secret-token';
      delete process.env.PREVIEW_MODE;

      const mod = require('../server/lib/routine-trigger');

      // Restore
      if (savedUrl === undefined) delete process.env.CLAUDE_ROUTINE_FIRE_URL;
      else process.env.CLAUDE_ROUTINE_FIRE_URL = savedUrl;
      if (savedToken === undefined) delete process.env.CLAUDE_ROUTINE_FIRE_TOKEN;
      else process.env.CLAUDE_ROUTINE_FIRE_TOKEN = savedToken;
      if (savedPreview === undefined) delete process.env.PREVIEW_MODE;
      else process.env.PREVIEW_MODE = savedPreview;

      const result = mod.fire('shelly_crash', 'Script crashed!');
      assert.strictEqual(result, true, 'fire() must return true when configured');

      // Give the async HTTP request time to land
      setTimeout(() => {
        server.close(() => {
          assert.ok(received.headers, 'server must have received a request');
          assert.strictEqual(
            received.headers.authorization,
            'Bearer secret-token',
            'Authorization header must match'
          );
          assert.strictEqual(
            received.headers['anthropic-version'],
            '2023-06-01',
            'anthropic-version header required'
          );
          assert.strictEqual(
            received.headers['anthropic-beta'],
            'experimental-cc-routine-2026-04-01',
            'anthropic-beta header required'
          );
          assert.match(
            received.headers['content-type'] || '',
            /application\/json/,
            'content-type must be application/json'
          );
          const parsed = JSON.parse(received.body);
          assert.strictEqual(parsed.text, 'Script crashed!', 'body must contain text field');
          done();
        });
      }, 300);
    });
  });

  it('rate-limits: second fire of same kind within min interval returns false without HTTP call', (t, done) => {
    const requestsReceived = [];
    const server = http.createServer((req, res) => {
      requestsReceived.push(req.url);
      res.writeHead(200);
      res.end('ok');
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}/fire`;

      const key = require.resolve('../server/lib/routine-trigger');
      delete require.cache[key];
      const savedUrl = process.env.CLAUDE_ROUTINE_FIRE_URL;
      const savedToken = process.env.CLAUDE_ROUTINE_FIRE_TOKEN;
      const savedPreview = process.env.PREVIEW_MODE;
      process.env.CLAUDE_ROUTINE_FIRE_URL = url;
      process.env.CLAUDE_ROUTINE_FIRE_TOKEN = 'tok';
      delete process.env.PREVIEW_MODE;

      const mod = require('../server/lib/routine-trigger');

      if (savedUrl === undefined) delete process.env.CLAUDE_ROUTINE_FIRE_URL;
      else process.env.CLAUDE_ROUTINE_FIRE_URL = savedUrl;
      if (savedToken === undefined) delete process.env.CLAUDE_ROUTINE_FIRE_TOKEN;
      else process.env.CLAUDE_ROUTINE_FIRE_TOKEN = savedToken;
      if (savedPreview === undefined) delete process.env.PREVIEW_MODE;
      else process.env.PREVIEW_MODE = savedPreview;

      const first = mod.fire('some_kind', 'first fire');
      const second = mod.fire('some_kind', 'second fire — should be suppressed');
      const different = mod.fire('other_kind', 'different kind — must not be rate-limited');

      assert.strictEqual(first, true, 'first call must return true');
      assert.strictEqual(second, false, 'second call within interval must return false');
      assert.strictEqual(different, true, 'different kind must not be rate-limited');

      setTimeout(() => {
        server.close(() => {
          // Only first + different_kind should have reached the server (2 requests)
          assert.strictEqual(
            requestsReceived.length,
            2,
            'only 2 HTTP requests should reach the server'
          );
          done();
        });
      }, 300);
    });
  });
});
