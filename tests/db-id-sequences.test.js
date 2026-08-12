/**
 * Regression tests for SEQUENCE_SYNC_SQL (db-schema).
 *
 * The 2026-08-02 on-prem migration copied rows with explicit ids
 * (`\copy … FROM STDOUT`), which does NOT advance the owning sequence. Every
 * subsequent insert therefore collided with an existing primary key:
 *
 *   script_crashes_id_seq.last_value = 3   while max(id) = 473
 *   routine_fires_id_seq.last_value  = 4   while max(id) = 109
 *
 * Both failures were silent for ten days — the server logged
 * "script crash insert failed: duplicate key value violates unique constraint"
 * at error level and carried on, so crash diagnostics and routine-fire history
 * simply stopped recording. Schema init now realigns every id sequence, which
 * is idempotent on a healthy database and repairs a restored one.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { SEQUENCE_SYNC_SQL } = require('../server/lib/db-schema');

describe('SEQUENCE_SYNC_SQL', () => {
  it('covers every table whose id comes from a sequence', () => {
    const tables = ['script_crashes', 'routine_fires', 'watchdog_events'];
    for (const t of tables) {
      assert.ok(
        SEQUENCE_SYNC_SQL.some((sql) => sql.includes(`'public.${t}'`)),
        `${t} must have its id sequence realigned on schema init`
      );
    }
  });

  it('derives the sequence name instead of hardcoding it', () => {
    for (const sql of SEQUENCE_SYNC_SQL) {
      assert.match(sql, /pg_get_serial_sequence/,
        'use pg_get_serial_sequence so a renamed sequence still resolves');
    }
  });

  it('is a no-op on an empty table rather than an error', () => {
    // setval() rejects values below the sequence minimum, so an empty table
    // must fall back to 1 with is_called=false — not to max(id) = NULL.
    for (const sql of SEQUENCE_SYNC_SQL) {
      assert.match(sql, /COALESCE\(MAX\(id\), 0\) \+ 1/,
        'target is max(id)+1, so an empty table yields 1 rather than NULL');
      assert.match(sql, /setval\(seq, GREATEST\(hi, cur\), false\)/,
        'is_called=false so the seeded value is the next id handed out');
    }
  });

  it('never lowers a healthy sequence below its current position', () => {
    // GREATEST against the live sequence value: on a healthy DB the sequence
    // is already ahead of max(id) (ids may have been consumed and rolled
    // back), and rewinding it would re-issue live keys.
    for (const sql of SEQUENCE_SYNC_SQL) {
      assert.match(sql, /GREATEST/,
        'must not rewind a sequence that is already ahead of max(id)');
    }
  });

  it('tolerates a table that does not exist yet', () => {
    for (const sql of SEQUENCE_SYNC_SQL) {
      assert.match(sql, /to_regclass/,
        'guard on to_regclass so a fresh database does not fail schema init');
    }
  });
});
