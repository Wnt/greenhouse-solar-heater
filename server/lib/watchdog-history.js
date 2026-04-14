// server/lib/watchdog-history.js
//
// Storage for watchdog_events with Postgres primary + in-memory
// ring-buffer fallback. Same pattern as other history features.

'use strict';

const MAX_RING = 200;

function createHistory({ db, log }) {
  if (db && typeof db.query === 'function') {
    return new PostgresHistory(db, log);
  }
  return new RingBufferHistory(log);
}

class PostgresHistory {
  constructor(db, log) {
    this.db = db;
    this.log = log;
  }

  async insert(row) {
    const result = await this.db.query(
      `INSERT INTO watchdog_events
       (watchdog_id, mode, fired_at, trigger_reason, resolution,
        resolved_at, snooze_until, snooze_reason, resolved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [row.watchdog_id, row.mode, row.fired_at, row.trigger_reason,
       row.resolution || null, row.resolved_at || null,
       row.snooze_until || null, row.snooze_reason || null, row.resolved_by || null]
    );
    return { id: result.rows[0].id };
  }

  async update(id, patch) {
    const fields = [];
    const values = [];
    let i = 1;
    for (const k of ['resolution', 'resolved_at', 'snooze_until', 'snooze_reason', 'resolved_by']) {
      if (patch[k] !== undefined) {
        fields.push(`${k} = $${i++}`);
        values.push(patch[k]);
      }
    }
    if (fields.length === 0) return;
    values.push(id);
    await this.db.query(
      `UPDATE watchdog_events SET ${fields.join(', ')} WHERE id = $${i}`,
      values
    );
  }

  async list(limit) {
    const result = await this.db.query(
      `SELECT * FROM watchdog_events ORDER BY fired_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }
}

class RingBufferHistory {
  constructor(log) {
    this.log = log;
    this.rows = [];
    this.nextId = 1;
  }

  async insert(row) {
    const entry = Object.assign({ id: this.nextId++ }, row);
    // Cap at MAX_RING by pruning the oldest (end of array) when we exceed.
    // The array is kept newest-first by convention so the most recent
    // entries are at the front.
    this.rows.unshift(entry);
    if (this.rows.length > MAX_RING) {
      this.rows.length = MAX_RING;
    }
    return { id: entry.id };
  }

  async update(id, patch) {
    const row = this.rows.find(r => r.id === id);
    if (row) Object.assign(row, patch);
  }

  async list(limit) {
    // Sort by fired_at DESC to match Postgres ordering
    const sorted = this.rows.slice().sort((a, b) => {
      const at = a.fired_at instanceof Date ? a.fired_at.getTime() : 0;
      const bt = b.fired_at instanceof Date ? b.fired_at.getTime() : 0;
      return bt - at;
    });
    return sorted.slice(0, limit);
  }
}

module.exports = { createHistory };
