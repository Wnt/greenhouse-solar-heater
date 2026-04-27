const { describe, it } = require('node:test');
const assert = require('node:assert');
const { diffConfig } = require('../server/lib/config-events.js');

// diffConfig is pure: takes (prev, next, source, actor) and returns
// the array of config_events rows that should be inserted to capture
// the wb / mo deltas. State_events table-shaped, used by every call
// site that writes config events.

describe('config-events diff — wb (mode bans)', () => {
  it('returns one row per added wb entry', () => {
    const rows = diffConfig(
      { wb: {} },
      { wb: { SC: 1840000000, GH: 1840014400 } },
      'api',
      'alice'
    );
    rows.sort((a, b) => a.key.localeCompare(b.key));
    assert.deepStrictEqual(rows, [
      { kind: 'wb', key: 'GH', old_value: null, new_value: '1840014400', source: 'api', actor: 'alice' },
      { kind: 'wb', key: 'SC', old_value: null, new_value: '1840000000', source: 'api', actor: 'alice' },
    ]);
  });

  it('returns one row per removed wb entry (clearing a cool-off)', () => {
    const rows = diffConfig(
      { wb: { SC: 1840000000 } },
      { wb: {} },
      'api',
      'alice'
    );
    assert.deepStrictEqual(rows, [
      { kind: 'wb', key: 'SC', old_value: '1840000000', new_value: null, source: 'api', actor: 'alice' },
    ]);
  });

  it('returns one row per changed wb entry', () => {
    const rows = diffConfig(
      { wb: { GH: 1840000000 } },
      { wb: { GH: 1840014400 } },
      'api',
      'alice'
    );
    assert.deepStrictEqual(rows, [
      { kind: 'wb', key: 'GH', old_value: '1840000000', new_value: '1840014400', source: 'api', actor: 'alice' },
    ]);
  });

  it('returns no rows when wb unchanged', () => {
    const rows = diffConfig(
      { wb: { GH: 1840000000 } },
      { wb: { GH: 1840000000 } },
      'api',
      'alice'
    );
    assert.deepStrictEqual(rows, []);
  });

  it('treats undefined wb on either side as empty', () => {
    const rows = diffConfig(
      {},
      { wb: { SC: 9999999999 } },
      'api',
      'alice'
    );
    assert.deepStrictEqual(rows, [
      { kind: 'wb', key: 'SC', old_value: null, new_value: '9999999999', source: 'api', actor: 'alice' },
    ]);
  });
});

describe('config-events diff — mo (manual override)', () => {
  it('null → active records the entry as one row', () => {
    const rows = diffConfig(
      { mo: null },
      { mo: { a: true, ex: 1840000000, fm: 'SC' } },
      'ws_override',
      'alice'
    );
    assert.deepStrictEqual(rows, [
      {
        kind: 'mo',
        key: null,
        old_value: null,
        new_value: JSON.stringify({ a: true, ex: 1840000000, fm: 'SC' }),
        source: 'ws_override',
        actor: 'alice',
      },
    ]);
  });

  it('active → null records the exit', () => {
    const rows = diffConfig(
      { mo: { a: true, ex: 1840000000, fm: 'AD' } },
      { mo: null },
      'ws_override',
      'alice'
    );
    assert.deepStrictEqual(rows, [
      {
        kind: 'mo',
        key: null,
        old_value: JSON.stringify({ a: true, ex: 1840000000, fm: 'AD' }),
        new_value: null,
        source: 'ws_override',
        actor: 'alice',
      },
    ]);
  });

  it('forced-mode change records the new override', () => {
    const rows = diffConfig(
      { mo: { a: true, ex: 1840000000, fm: 'SC' } },
      { mo: { a: true, ex: 1840003600, fm: 'AD' } },
      'ws_override',
      'alice'
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].kind, 'mo');
  });

  it('null → null returns nothing', () => {
    const rows = diffConfig({ mo: null }, { mo: null }, 'api', 'alice');
    assert.deepStrictEqual(rows, []);
  });

  it('treats missing mo on either side as null', () => {
    const rows = diffConfig({}, {}, 'api', 'alice');
    assert.deepStrictEqual(rows, []);
  });
});

describe('config-events diff — combined wb + mo deltas', () => {
  it('emits rows for both fields when both change in one update', () => {
    const rows = diffConfig(
      { wb: {}, mo: null },
      { wb: { SC: 9999999999 }, mo: { a: true, ex: 1840000000, fm: 'SC' } },
      'api',
      'alice'
    );
    assert.strictEqual(rows.length, 2);
    const kinds = rows.map(r => r.kind).sort();
    assert.deepStrictEqual(kinds, ['mo', 'wb']);
  });

  it('ignores changes to non-tracked fields (ce, ea, we, wz, v)', () => {
    const rows = diffConfig(
      { ce: false, ea: 0, we: {}, wz: {}, wb: {}, mo: null, v: 1 },
      { ce: true, ea: 31, we: { ggr: 1 }, wz: { ggr: 1840003600 }, wb: {}, mo: null, v: 2 },
      'api',
      'alice'
    );
    assert.deepStrictEqual(rows, []);
  });
});
