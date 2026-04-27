'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { install, shouldSuppress } = require('./e2e/_setup/silence-pgmem-noise');

// A representative line emitted by server/lib/logger.js when
// server/lib/http-handlers.js:handleHistoryApi catches pg-mem's
// "Unexpected kw_order" parse failure on the production UNION ALL
// history query.
const NOISE_LINE = JSON.stringify({
  ts: '2026-04-27T18:39:40.998Z',
  level: 'error',
  component: 'http',
  msg: 'history query failed',
  error: '💔 Your query failed to parse.\n... Unexpected kw_order token: "order". ...',
}) + '\n';

describe('silence-pgmem-noise', () => {
  describe('shouldSuppress', () => {
    it('matches the pg-mem history-query parse-failure log line', () => {
      assert.strictEqual(shouldSuppress(NOISE_LINE), true);
    });

    it('does not match unrelated http error lines', () => {
      const line = JSON.stringify({
        level: 'error', component: 'http', msg: 'events query failed',
        error: 'connection refused',
      }) + '\n';
      assert.strictEqual(shouldSuppress(line), false);
    });

    it('does not match unrelated pg-mem failures (different msg)', () => {
      const line = JSON.stringify({
        level: 'error', component: 'db', msg: 'maintenance failed',
        error: 'Unexpected kw_order token',
      }) + '\n';
      assert.strictEqual(shouldSuppress(line), false);
    });

    it('does not match history failures from other parsers', () => {
      const line = JSON.stringify({
        level: 'error', component: 'http', msg: 'history query failed',
        error: 'connection terminated unexpectedly',
      }) + '\n';
      assert.strictEqual(shouldSuppress(line), false);
    });

    it('handles non-string input safely', () => {
      assert.strictEqual(shouldSuppress(null), false);
      assert.strictEqual(shouldSuppress(undefined), false);
      assert.strictEqual(shouldSuppress(123), false);
    });
  });

  describe('install', () => {
    function fakeStream() {
      const captured = [];
      return {
        captured,
        write(chunk, _encoding, cb) {
          captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
          if (typeof _encoding === 'function') _encoding();
          else if (typeof cb === 'function') cb();
          return true;
        },
      };
    }

    it('drops matching lines from the stream', () => {
      const stream = fakeStream();
      install(stream);
      stream.write(NOISE_LINE);
      assert.deepStrictEqual(stream.captured, []);
    });

    it('passes through unrelated lines untouched', () => {
      const stream = fakeStream();
      install(stream);
      const passthrough = '{"level":"info","msg":"booted"}\n';
      stream.write(passthrough);
      assert.deepStrictEqual(stream.captured, [passthrough]);
    });

    it('invokes the write callback even when suppressing', () => {
      const stream = fakeStream();
      install(stream);
      let called = false;
      stream.write(NOISE_LINE, 'utf8', () => { called = true; });
      assert.strictEqual(called, true);
    });

    it('invokes the write callback when callback is the second arg', () => {
      const stream = fakeStream();
      install(stream);
      let called = false;
      stream.write(NOISE_LINE, () => { called = true; });
      assert.strictEqual(called, true);
    });

    it('returns an uninstall fn that restores the original write', () => {
      const stream = fakeStream();
      const uninstall = install(stream);
      uninstall();
      stream.write(NOISE_LINE);
      assert.deepStrictEqual(stream.captured, [NOISE_LINE]);
    });

    it('handles Buffer chunks', () => {
      const stream = fakeStream();
      install(stream);
      stream.write(Buffer.from(NOISE_LINE));
      assert.deepStrictEqual(stream.captured, []);
    });
  });
});
