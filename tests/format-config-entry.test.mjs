import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatConfigEntry, formatConfigSourceLabel } from '../playground/js/main/time-format.js';

describe('formatConfigEntry — wb (mode bans)', () => {
  it('cool-off ban set (timestamp, not the permanent sentinel)', () => {
    const out = formatConfigEntry({
      eventType: 'config', configKind: 'wb', configKey: 'GH',
      from: null, to: '1840014400',
      source: 'watchdog_auto', actor: 'device',
    });
    assert.equal(out.title, 'Banned mode (cool-off): Greenhouse Heating');
    assert.match(out.desc, /watchdog auto-shutdown by device/);
  });

  it('permanent disable (sentinel 9999999999) — set via mode-enablement UI', () => {
    const out = formatConfigEntry({
      eventType: 'config', configKind: 'wb', configKey: 'SC',
      from: null, to: '9999999999',
      source: 'api', actor: 'alice',
    });
    assert.equal(out.title, 'Disabled mode: Solar Charging');
    assert.match(out.desc, /mode-enablement UI by alice/);
  });

  it('re-enable (entry removed) — clearing the cool-off / re-enabling the mode', () => {
    const out = formatConfigEntry({
      eventType: 'config', configKind: 'wb', configKey: 'GH',
      from: '9999999999', to: null,
      source: 'api', actor: 'alice',
    });
    assert.equal(out.title, 'Re-enabled mode: Greenhouse Heating');
  });

  it('updated ban (timestamp swap)', () => {
    const out = formatConfigEntry({
      eventType: 'config', configKind: 'wb', configKey: 'GH',
      from: '1840000000', to: '1840014400',
      source: 'watchdog_auto', actor: 'device',
    });
    assert.equal(out.title, 'Updated ban: Greenhouse Heating');
  });

  it('falls back gracefully on an unknown mode code', () => {
    const out = formatConfigEntry({
      eventType: 'config', configKind: 'wb', configKey: 'ZZ',
      from: null, to: '9999999999', source: 'api', actor: 'alice',
    });
    assert.equal(out.title, 'Disabled mode: ZZ');
  });
});

describe('formatConfigEntry — mo (manual override)', () => {
  it('override entered (null → object)', () => {
    const out = formatConfigEntry({
      eventType: 'config', configKind: 'mo', configKey: null,
      from: null,
      to: JSON.stringify({ a: true, ex: 1840003600, fm: 'SC' }),
      source: 'ws_override', actor: 'alice',
    });
    assert.equal(out.title, 'Manual override: Solar Charging');
    assert.match(out.desc, /device view by alice/);
  });

  it('override exited (object → null)', () => {
    const out = formatConfigEntry({
      eventType: 'config', configKind: 'mo', configKey: null,
      from: JSON.stringify({ a: true, ex: 1840003600, fm: 'AD' }),
      to: null,
      source: 'ws_override', actor: 'alice',
    });
    assert.equal(out.title, 'Manual override exited');
  });

  it('TTL expiry path attributes the actor as ttl_expiry', () => {
    const out = formatConfigEntry({
      eventType: 'config', configKind: 'mo', configKey: null,
      from: JSON.stringify({ a: true, ex: 1840003600, fm: 'AD' }),
      to: null,
      source: 'ws_override', actor: 'ttl_expiry',
    });
    assert.match(out.desc, /by ttl_expiry/);
  });

  it('forced mode swap (object → object) shows the new fm', () => {
    const out = formatConfigEntry({
      eventType: 'config', configKind: 'mo', configKey: null,
      from: JSON.stringify({ a: true, ex: 1840000000, fm: 'SC' }),
      to: JSON.stringify({ a: true, ex: 1840003600, fm: 'AD' }),
      source: 'ws_override', actor: 'alice',
    });
    assert.equal(out.title, 'Manual override updated: Active Drain');
  });
});

describe('formatConfigSourceLabel', () => {
  it('maps every known source', () => {
    assert.equal(formatConfigSourceLabel('api'), 'mode-enablement UI');
    assert.equal(formatConfigSourceLabel('ws_override'), 'device view');
    assert.equal(formatConfigSourceLabel('watchdog_auto'), 'watchdog auto-shutdown');
    assert.equal(formatConfigSourceLabel('watchdog_user'), 'watchdog banner');
  });

  it('falls back to the raw value (or "unknown source") for unmapped inputs', () => {
    assert.equal(formatConfigSourceLabel('something_new'), 'something_new');
    assert.equal(formatConfigSourceLabel(null), 'unknown source');
  });
});
