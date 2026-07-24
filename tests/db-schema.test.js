'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../server/lib/db-schema.js');

function makeLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

// Scripted client for the migration probes: answers information_schema
// queries from the given fixture, records every statement, and returns
// empty rows for DDL. Mirrors the (sql, cb) call shape db.js's client
// uses inside initSchema.
function makeClient(fx) {
  const calls = [];
  return {
    calls,
    query(sql, cb) {
      calls.push(sql);
      if (/information_schema\.tables/.test(sql)) {
        cb(null, { rows: fx.tableExists ? [{ x: 1 }] : [] });
        return;
      }
      if (/column_name='horizon_h'/.test(sql)) {
        cb(null, { rows: fx.hasHorizonH ? [{ x: 1 }] : [] });
        return;
      }
      if (/table_constraints/.test(sql)) {
        cb(null, { rows: fx.pkRows || [] });
        return;
      }
      cb(null, { rows: [] }); // DDL statements
    },
  };
}

function pkRows(columns) {
  return columns.map((c) => ({ constraint_name: 'forecast_predictions_pkey', column_name: c }));
}

function ddlCalls(client) {
  return client.calls.filter((sql) => /^(ALTER|DROP)\b/.test(sql));
}

describe('db-schema SCHEMA_SQL forecast_predictions shape', () => {
  const createStmt = schema.SCHEMA_SQL.find(
    (s) => s.includes('CREATE TABLE IF NOT EXISTS forecast_predictions')
  );

  it('declares the engine discriminator column with a physics default', () => {
    assert.ok(createStmt, 'forecast_predictions CREATE TABLE missing');
    assert.match(createStmt, /engine\s+TEXT\s+NOT NULL DEFAULT 'physics'/);
  });

  it('keys the table on (engine, generated_at, horizon_h)', () => {
    assert.match(createStmt, /PRIMARY KEY \(engine, generated_at, horizon_h\)/);
  });
});

describe('db-schema SCHEMA_SQL as-of index shape (PR #283 index debt)', () => {
  const all = schema.SCHEMA_SQL.join('\n');

  it('replaces the single-column weather valid_at indexes with the as-of composite', () => {
    // Prod carried two identical single-column indexes (the explicit
    // weather_forecasts_valid_at plus the hypertable auto-created
    // *_valid_at_idx) while the hot as-of/nowcast pattern
    // (DISTINCT ON (valid_at) ... ORDER BY valid_at, fetched_at DESC)
    // had no matching composite. The PK leads on fetched_at so it
    // cannot serve valid_at scans.
    assert.match(all, /DROP INDEX IF EXISTS weather_forecasts_valid_at_idx/);
    assert.match(all, /DROP INDEX IF EXISTS weather_forecasts_valid_at\b/);
    assert.match(all,
      /CREATE INDEX IF NOT EXISTS weather_forecasts_valid_fetched ON weather_forecasts \(valid_at, fetched_at DESC\)/);
    assert.doesNotMatch(all,
      /CREATE INDEX IF NOT EXISTS weather_forecasts_valid_at ON/,
      'the old single-column index must not be recreated');
  });

  it('drops both redundant spot_prices valid_at indexes (PK already leads on valid_at)', () => {
    assert.match(all, /DROP INDEX IF EXISTS spot_prices_valid_at_idx/);
    assert.match(all, /DROP INDEX IF EXISTS spot_prices_valid_at\b/);
    assert.doesNotMatch(all, /CREATE INDEX IF NOT EXISTS spot_prices_valid_at ON/,
      'spot_prices needs no extra index: PRIMARY KEY (valid_at, source) covers the scans');
  });

  it('orders the weather drops after create_hypertable so fresh installs converge', () => {
    const stmts = schema.SCHEMA_SQL;
    const hyper = stmts.findIndex((s) => /create_hypertable\('weather_forecasts'/.test(s));
    const drop = stmts.findIndex((s) => /DROP INDEX IF EXISTS weather_forecasts_valid_at_idx/.test(s));
    assert.ok(hyper !== -1 && drop !== -1 && drop > hyper,
      'auto-index drop must run after create_hypertable creates it on fresh installs');
  });
});

describe('db-schema._pkNeedsEngineMigration', () => {
  const fn = schema._pkNeedsEngineMigration;

  it('is exported as a pure probe helper', () => {
    assert.equal(typeof fn, 'function');
  });

  it('wants migration when the PK lacks the engine column', () => {
    assert.equal(fn(['generated_at', 'horizon_h']), true);
  });

  it('is a no-op once engine is part of the PK', () => {
    assert.equal(fn(['engine', 'generated_at', 'horizon_h']), false);
  });

  it('wants migration when no PK exists at all (defensive)', () => {
    assert.equal(fn([]), true);
    assert.equal(fn(null), true);
  });
});

describe('db-schema.migrateLegacyForecastPredictions (chained engine migration)', () => {
  it('no-ops when the table does not exist yet (fresh install)', (t, done) => {
    const client = makeClient({ tableExists: false });
    schema.migrateLegacyForecastPredictions(client, makeLog(), (err) => {
      assert.ifError(err);
      assert.equal(ddlCalls(client).length, 0);
      done();
    });
  });

  it('still drops the pre-2026-05-08 legacy shape (no horizon_h)', (t, done) => {
    const client = makeClient({ tableExists: true, hasHorizonH: false });
    schema.migrateLegacyForecastPredictions(client, makeLog(), (err) => {
      assert.ifError(err);
      const ddl = ddlCalls(client);
      assert.equal(ddl.length, 1);
      assert.match(ddl[0], /DROP TABLE forecast_predictions/);
      done();
    });
  });

  it('migrates a (generated_at, horizon_h) PK to (engine, generated_at, horizon_h)', (t, done) => {
    const client = makeClient({
      tableExists: true,
      hasHorizonH: true,
      pkRows: pkRows(['generated_at', 'horizon_h']),
    });
    schema.migrateLegacyForecastPredictions(client, makeLog(), (err) => {
      assert.ifError(err);
      const ddl = ddlCalls(client);
      assert.ok(ddl.some((s) =>
        /ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'physics'/.test(s)),
        'expected engine ADD COLUMN, got: ' + JSON.stringify(ddl));
      assert.ok(ddl.some((s) => /DROP CONSTRAINT "forecast_predictions_pkey"/.test(s)),
        'expected old PK dropped, got: ' + JSON.stringify(ddl));
      assert.ok(ddl.some((s) =>
        /ADD PRIMARY KEY \(engine, generated_at, horizon_h\)/.test(s)),
        'expected new PK, got: ' + JSON.stringify(ddl));
      // ADD COLUMN must precede the PK swap — the new PK references it.
      const addColIdx = ddl.findIndex((s) => /ADD COLUMN/.test(s));
      const addPkIdx = ddl.findIndex((s) => /ADD PRIMARY KEY/.test(s));
      assert.ok(addColIdx < addPkIdx, 'ADD COLUMN must run before ADD PRIMARY KEY');
      done();
    });
  });

  it('is idempotent: no DDL once the PK already includes engine', (t, done) => {
    const client = makeClient({
      tableExists: true,
      hasHorizonH: true,
      pkRows: pkRows(['engine', 'generated_at', 'horizon_h']),
    });
    schema.migrateLegacyForecastPredictions(client, makeLog(), (err) => {
      assert.ifError(err);
      assert.equal(ddlCalls(client).length, 0);
      done();
    });
  });

  it('treats a PK-probe failure as non-fatal (boot continues)', (t, done) => {
    const client = {
      calls: [],
      query(sql, cb) {
        client.calls.push(sql);
        if (/information_schema\.tables/.test(sql)) { cb(null, { rows: [{ x: 1 }] }); return; }
        if (/column_name='horizon_h'/.test(sql)) { cb(null, { rows: [{ x: 1 }] }); return; }
        cb(new Error('probe blew up'));
      },
    };
    schema.migrateLegacyForecastPredictions(client, makeLog(), (err) => {
      assert.ifError(err);
      done();
    });
  });
});
