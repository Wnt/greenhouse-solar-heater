/**
 * Regression: /api/history's events list was range-filtered the same way
 * sensor readings are, leaving the client with no way to know what mode
 * was active at the start of the visible window. The bar renderer and the
 * sensor-readings table both reconstructed mode-per-sample from a default
 * `idle`, so a controller that was already in solar_charging when the
 * window opened — or one that transitioned outside the window — produced
 * graph bars that disagreed with the transition log.
 *
 * Fix: getEvents must include the most recent event with the same
 * entity_type from BEFORE the window (the "leading event"), prepended to
 * the in-window events. Then `modeAt(ts)` is well-defined for any ts in
 * the window.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

describe('db.getEvents — leading event', () => {
  let db;
  let capturedQueries;

  beforeEach(() => {
    capturedQueries = [];
    delete require.cache[require.resolve('../server/lib/db.js')];
    const mockPool = {
      on: function () {},
      query: function (sql, params, cb) {
        if (typeof params === 'function') { cb = params; params = []; }
        capturedQueries.push({ sql, params });
        if (cb) cb(null, { rows: [] });
      },
      end: function (cb) { if (cb) cb(); },
    };
    require.cache[require.resolve('pg')] = {
      id: require.resolve('pg'),
      exports: { Pool: function () { return mockPool; } },
    };
    db = require('../server/lib/db.js');
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
  });

  it('range=6h query unions in-window events with a leading-edge subquery', (t, done) => {
    db.getEvents('6h', 'mode', function (err) {
      assert.ifError(err);
      const eventsQ = capturedQueries.find(q => q.sql && q.sql.includes('state_events'));
      assert.ok(eventsQ, 'expected a state_events query');
      // The leading-edge lookup picks the single most-recent event of this
      // type from BEFORE the window so the client can resolve "what mode
      // was active at window-start".
      assert.match(
        eventsQ.sql,
        /ts <= NOW\(\) - INTERVAL '6 hours'/,
        'expected a leading-edge bound at the window start',
      );
      assert.match(
        eventsQ.sql,
        /ORDER BY ts DESC[\s\S]*LIMIT 1/i,
        'expected the leading-edge subquery to take the single newest pre-window row',
      );
      assert.match(
        eventsQ.sql,
        /UNION ALL/i,
        'expected the leading event to be UNION ALL-ed with the in-window rows',
      );
      done();
    });
  });

  it('range=all is unaffected (no window, so no leading event needed)', (t, done) => {
    db.getEvents('all', 'mode', function (err) {
      assert.ifError(err);
      const eventsQ = capturedQueries.find(q => q.sql && q.sql.includes('state_events'));
      assert.ok(eventsQ);
      assert.ok(!/UNION ALL/i.test(eventsQ.sql), 'range=all has no window so no leading-event UNION');
      done();
    });
  });
});
