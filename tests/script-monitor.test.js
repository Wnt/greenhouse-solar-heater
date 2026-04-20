/**
 * script-monitor unit tests.
 *
 * Exercises the monitor with an injected rpc() so no real HTTP fires.
 * Fake DB captures insertScriptCrash payloads for assertion.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createScriptMonitor } = require('../server/lib/script-monitor');

function makeFakeDb() {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    insertScriptCrash(row, cb) {
      const id = nextId++;
      rows.push(Object.assign({ id }, row));
      setImmediate(() => cb(null, id));
    },
    resolveScriptCrash(id, cb) {
      const row = rows.find(r => r.id === id);
      if (row) { row.resolved_at = new Date(); setImmediate(() => cb(null, true)); }
      else setImmediate(() => cb(null, false));
    },
  };
}

// rpc spy — responds based on a scripted queue of per-method replies.
function makeRpc(script) {
  const calls = [];
  function rpc(host, method, params, timeoutMs, cb) {
    calls.push({ host, method, params });
    const reply = script[method] ? script[method].shift() || script[method][script[method].length - 1] : null;
    if (!reply) { setImmediate(() => cb(new Error('no scripted reply for ' + method))); return; }
    if (reply.err) setImmediate(() => cb(reply.err));
    else setImmediate(() => cb(null, reply.result));
  }
  return { rpc, calls };
}

describe('script-monitor', () => {
  it('captures a crash row when running flips from true → false', (t, done) => {
    const db = makeFakeDb();
    const script = {
      'Script.GetStatus': [
        { result: { id: 1, running: true } },                                   // initial boot poll
        { result: { id: 1, running: false, errors: ['error'],
                    error_msg: 'Uncaught Error: Too much recursion' } },        // crash
      ],
      'Sys.GetStatus': [
        { result: { uptime: 12345, ram_free: 45678, reset_reason: 3 } },
      ],
    };
    const { rpc } = makeRpc(script);
    const mon = createScriptMonitor({ host: 'x.x.x.x', scriptId: 1, rpc, db });

    // Seed a few snapshots so the ring buffer is exercised.
    mon.recordStateSnapshot({ ts: 1, mode: 'IDLE', temps: { collector: 20 } });
    mon.recordStateSnapshot({ ts: 2, mode: 'IDLE', temps: { collector: 21 } });

    mon.pollOnce(() => {
      // First poll reports running; nothing to capture.
      assert.strictEqual(db.rows.length, 0);
      const status1 = mon.getStatus();
      assert.strictEqual(status1.running, true);

      mon.pollOnce(() => {
        assert.strictEqual(db.rows.length, 1, 'crash row written on first running=false poll');
        const row = db.rows[0];
        assert.match(row.error_msg, /Too much recursion/);
        assert.deepStrictEqual(row.sys_status, { uptime: 12345, ram_free: 45678, reset_reason: 3 });
        assert.strictEqual(row.recent_states.length, 2);
        assert.strictEqual(row.recent_states[0].mode, 'IDLE');
        const status2 = mon.getStatus();
        assert.strictEqual(status2.running, false);
        assert.strictEqual(status2.crashId, 1);
        assert.match(status2.error_msg, /Too much recursion/);
        done();
      });
    });
  });

  it('does NOT re-insert a crash row when the script stays down across polls', (t, done) => {
    const db = makeFakeDb();
    const script = {
      'Script.GetStatus': [
        { result: { id: 1, running: false, errors: ['error'], error_msg: 'boom' } },
        { result: { id: 1, running: false, errors: ['error'], error_msg: 'boom' } },
        { result: { id: 1, running: false, errors: ['error'], error_msg: 'boom' } },
      ],
      'Sys.GetStatus': [{ result: { uptime: 1 } }],
    };
    const { rpc } = makeRpc(script);
    const mon = createScriptMonitor({ host: 'x', rpc, db });

    mon.pollOnce(() => mon.pollOnce(() => mon.pollOnce(() => {
      assert.strictEqual(db.rows.length, 1, 'exactly one crash row across three down polls');
      done();
    })));
  });

  it('clears the crash context when the script comes back up', (t, done) => {
    const db = makeFakeDb();
    const script = {
      'Script.GetStatus': [
        { result: { id: 1, running: true } },
        { result: { id: 1, running: false, errors: ['error'], error_msg: 'boom' } },
        { result: { id: 1, running: true } },
      ],
      'Sys.GetStatus': [{ result: { uptime: 1 } }],
    };
    const { rpc } = makeRpc(script);
    const mon = createScriptMonitor({ host: 'x', rpc, db });

    mon.pollOnce(() => mon.pollOnce(() => mon.pollOnce(() => {
      const s = mon.getStatus();
      assert.strictEqual(s.running, true);
      assert.strictEqual(s.error_msg, null);
      assert.strictEqual(s.crashId, null);
      assert.strictEqual(db.rows.length, 1);
      done();
    })));
  });

  it('ring buffer is capped and keeps the newest entries', () => {
    const mon = createScriptMonitor({ host: 'x', rpc: () => {}, bufferSize: 3 });
    for (let i = 0; i < 10; i++) {
      mon.recordStateSnapshot({ ts: i, mode: 'IDLE' });
    }
    const buf = mon._getRecentStates();
    assert.strictEqual(buf.length, 3);
    assert.deepStrictEqual(buf.map(e => e.ts), [7, 8, 9]);
  });

  it('fires status-change listeners on transitions, not on every poll', (t, done) => {
    const db = makeFakeDb();
    const script = {
      'Script.GetStatus': [
        { result: { id: 1, running: true } },
        { result: { id: 1, running: true } },
        { result: { id: 1, running: false, errors: ['error'], error_msg: 'boom' } },
      ],
      'Sys.GetStatus': [{ result: {} }],
    };
    const { rpc } = makeRpc(script);
    const mon = createScriptMonitor({ host: 'x', rpc, db });
    const events = [];
    mon.onStatusChange(s => events.push(s.running));

    mon.pollOnce(() => mon.pollOnce(() => mon.pollOnce(() => {
      // Expect exactly two transitions reaching listeners: first "running=true" (initial
      // boot state) and the crash observed on the third poll.
      assert.deepStrictEqual(events, [true, false]);
      done();
    })));
  });

  it('triggerRestart calls Script.Stop then Script.Start', (t, done) => {
    const script = {
      'Script.Stop':   [{ result: { was_running: false } }],
      'Script.Start':  [{ result: { was_running: false } }],
      'Script.GetStatus': [{ result: { id: 1, running: true } }],
    };
    const { rpc, calls } = makeRpc(script);
    const mon = createScriptMonitor({ host: 'x', rpc, db: makeFakeDb() });
    mon.triggerRestart((err, res) => {
      assert.ifError(err);
      assert.strictEqual(res.ok, true);
      const methods = calls.map(c => c.method);
      assert.ok(methods.indexOf('Script.Stop') < methods.indexOf('Script.Start'),
        'stop must precede start, got ' + methods.join(' → '));
      done();
    });
  });

  it('recovers from transient rpc failures: reachability flag tracks success/failure', (t, done) => {
    const script = {
      'Script.GetStatus': [
        { err: new Error('timeout') },
        { result: { id: 1, running: true } },
      ],
    };
    const { rpc } = makeRpc(script);
    const mon = createScriptMonitor({ host: 'x', rpc, db: makeFakeDb() });

    mon.pollOnce(() => {
      assert.strictEqual(mon.getStatus().reachable, false);
      mon.pollOnce(() => {
        const s = mon.getStatus();
        assert.strictEqual(s.reachable, true);
        assert.strictEqual(s.running, true);
        done();
      });
    });
  });
});
