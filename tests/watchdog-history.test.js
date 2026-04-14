const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

describe('watchdog-history ring buffer fallback', () => {
  let history;
  beforeEach(() => {
    const { createHistory } = require('../server/lib/watchdog-history.js');
    history = createHistory({ db: null, log: { warn: () => {}, error: () => {} } });
  });

  it('insert returns sequential ids', async () => {
    const a = await history.insert({ watchdog_id: 'ggr', trigger_reason: 'a', fired_at: new Date(), mode: 'GH' });
    const b = await history.insert({ watchdog_id: 'ggr', trigger_reason: 'b', fired_at: new Date(), mode: 'GH' });
    assert.strictEqual(a.id, 1);
    assert.strictEqual(b.id, 2);
  });

  it('update patches an existing row', async () => {
    const row = await history.insert({ watchdog_id: 'scs', trigger_reason: 'test', fired_at: new Date(), mode: 'SC' });
    await history.update(row.id, { resolution: 'snoozed', resolved_at: new Date() });
    const list = await history.list(10);
    assert.strictEqual(list[0].resolution, 'snoozed');
  });

  it('list returns most-recent-first, respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await history.insert({ watchdog_id: 'ggr', trigger_reason: 't' + i, fired_at: new Date(Date.now() + i), mode: 'GH' });
    }
    const list = await history.list(3);
    assert.strictEqual(list.length, 3);
    assert.strictEqual(list[0].trigger_reason, 't4');
  });

  it('caps ring buffer at 200 entries', async () => {
    for (let i = 0; i < 250; i++) {
      await history.insert({ watchdog_id: 'ggr', trigger_reason: 't' + i, fired_at: new Date(), mode: 'GH' });
    }
    const list = await history.list(500);
    assert.strictEqual(list.length, 200);
  });
});
