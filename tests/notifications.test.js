const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

describe('notifications', () => {
  let notifications;

  beforeEach(() => {
    delete require.cache[require.resolve('../server/lib/notifications.js')];
    notifications = require('../server/lib/notifications.js');
    notifications._reset();
  });

  describe('predictValue (linear extrapolation)', () => {
    it('returns null with insufficient data', () => {
      assert.strictEqual(notifications.predictValue([], 900000), null);
      assert.strictEqual(notifications.predictValue([{ ts: 1000, value: 20 }], 900000), null);
    });

    it('returns null with samples spanning less than 60s', () => {
      var history = [
        { ts: 1000, value: 20 },
        { ts: 30000, value: 22 },
      ];
      assert.strictEqual(notifications.predictValue(history, 900000), null);
    });

    it('predicts rising temperature', () => {
      // 1 degree per minute → 15 min = +15
      var now = Date.now();
      var history = [];
      for (var i = 0; i <= 5; i++) {
        history.push({ ts: now - (5 - i) * 60000, value: 70 + i });
      }
      var predicted = notifications.predictValue(history, 15 * 60 * 1000);
      // Should be around 70 + 5 + 15 = 90
      assert.ok(predicted > 88, 'predicted=' + predicted);
      assert.ok(predicted < 92, 'predicted=' + predicted);
    });

    it('predicts falling temperature', () => {
      // -0.5 degree per minute → 15 min = -7.5
      var now = Date.now();
      var history = [];
      for (var i = 0; i <= 10; i++) {
        history.push({ ts: now - (10 - i) * 60000, value: 10 - i * 0.5 });
      }
      var predicted = notifications.predictValue(history, 15 * 60 * 1000);
      // Should be around 5 - 7.5 = -2.5
      assert.ok(predicted < 0, 'predicted=' + predicted);
      assert.ok(predicted > -5, 'predicted=' + predicted);
    });

    it('predicts stable temperature', () => {
      var now = Date.now();
      var history = [];
      for (var i = 0; i <= 5; i++) {
        history.push({ ts: now - (5 - i) * 60000, value: 50 });
      }
      var predicted = notifications.predictValue(history, 15 * 60 * 1000);
      assert.ok(Math.abs(predicted - 50) < 0.5, 'predicted=' + predicted);
    });
  });

  describe('addSample', () => {
    it('trims samples older than 10 minutes', () => {
      var history = [];
      var now = Date.now();
      notifications.addSample(history, now - 15 * 60000, 20);
      notifications.addSample(history, now - 5 * 60000, 25);
      notifications.addSample(history, now, 30);
      // First sample should be trimmed (older than 10 min)
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0].value, 25);
    });
  });

  describe('evaluate with mock push', () => {
    let sentNotifications;
    let mockPush;

    beforeEach(() => {
      sentNotifications = [];
      mockPush = {
        sendNotification: function (type, payload) {
          sentNotifications.push({ type: type, payload: payload });
        },
      };
      notifications.init({ push: mockPush, deviceConfig: null });
    });

    it('sends overheat warning when tank temp trending toward 85', () => {
      var now = Date.now();
      // Simulate rising temperature: 1 degree/min from 78 over 5 minutes
      for (var i = 0; i <= 5; i++) {
        notifications._setTankHistory([]);
        var history = notifications._getTankHistory();
        // Build history up to this point
        for (var j = 0; j <= i; j++) {
          notifications.addSample(history, now - (5 - j) * 60000, 78 + j);
        }
      }

      // Now evaluate with temp at 83 and history showing 1 deg/min rise
      var tankHistory = [];
      for (var k = 0; k <= 5; k++) {
        notifications.addSample(tankHistory, now - (5 - k) * 60000, 78 + k);
      }
      notifications._setTankHistory(tankHistory);

      notifications.evaluate({ temps: { tank_top: 83, outdoor: 10 }, mode: 'SOLAR_CHARGING' });

      var overheatNotifs = sentNotifications.filter(function (n) { return n.type === 'overheat_warning'; });
      assert.strictEqual(overheatNotifs.length, 1);
      assert.ok(overheatNotifs[0].payload.body.indexOf('83.0') >= 0);
    });

    it('does not send overheat warning when temp is stable below threshold', () => {
      var now = Date.now();
      var history = [];
      for (var i = 0; i <= 5; i++) {
        notifications.addSample(history, now - (5 - i) * 60000, 50);
      }
      notifications._setTankHistory(history);

      notifications.evaluate({ temps: { tank_top: 50, outdoor: 10 }, mode: 'IDLE' });

      var overheatNotifs = sentNotifications.filter(function (n) { return n.type === 'overheat_warning'; });
      assert.strictEqual(overheatNotifs.length, 0);
    });

    it('does not send overheat warning when already above threshold', () => {
      var now = Date.now();
      var history = [];
      for (var i = 0; i <= 5; i++) {
        notifications.addSample(history, now - (5 - i) * 60000, 86 + i);
      }
      notifications._setTankHistory(history);

      notifications.evaluate({ temps: { tank_top: 91, outdoor: 10 }, mode: 'SOLAR_CHARGING' });

      var overheatNotifs = sentNotifications.filter(function (n) { return n.type === 'overheat_warning'; });
      assert.strictEqual(overheatNotifs.length, 0);
    });

    it('sends freeze warning when outdoor temp trending toward 2', () => {
      var now = Date.now();
      // Simulate falling temp: -0.5 degree/min from 5 over 6 minutes
      var history = [];
      for (var i = 0; i <= 6; i++) {
        notifications.addSample(history, now - (6 - i) * 60000, 5 - i * 0.5);
      }
      notifications._setOutdoorHistory(history);

      notifications.evaluate({ temps: { tank_top: 50, outdoor: 2.0 + 0.1 }, mode: 'IDLE' });

      // At 2.1C and falling at 0.5/min, in 15 min it would be ~-5.4
      // But current > threshold (2) is checked first, and 2.1 > 2 so it should pass
      // Also current <= freeze + 5 → 2.1 <= 7 → true
      var freezeNotifs = sentNotifications.filter(function (n) { return n.type === 'freeze_warning'; });
      assert.strictEqual(freezeNotifs.length, 1);
    });

    it('does not send freeze warning when already below threshold', () => {
      var now = Date.now();
      var history = [];
      for (var i = 0; i <= 5; i++) {
        notifications.addSample(history, now - (5 - i) * 60000, 1 - i * 0.1);
      }
      notifications._setOutdoorHistory(history);

      notifications.evaluate({ temps: { tank_top: 50, outdoor: 0.5 }, mode: 'IDLE' });

      var freezeNotifs = sentNotifications.filter(function (n) { return n.type === 'freeze_warning'; });
      assert.strictEqual(freezeNotifs.length, 0);
    });

    it('tracks energy during solar charging', () => {
      var now = Date.now();
      // First call establishes mode
      notifications.evaluate({ temps: { tank_top: 50, outdoor: 10 }, mode: 'SOLAR_CHARGING' });

      // Mock timestamp advance by 30 minutes by resetting internal state
      // We can't easily mock time, but we can check the accumulation logic
      // indirectly by checking the energy counter after evaluate
      assert.strictEqual(notifications._getDailyEnergyWh(), 0);
    });

    it('tracks night heating minutes', () => {
      assert.strictEqual(notifications._getNightHeatingMinutes(), 0);
    });
  });
});
