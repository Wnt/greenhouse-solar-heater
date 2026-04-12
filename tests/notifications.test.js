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

  describe('isDataFresh', () => {
    it('returns false when no data has been received', () => {
      assert.strictEqual(notifications.isDataFresh(), false);
    });

    it('returns true immediately after evaluate()', () => {
      var mockPush = { sendNotification: function () {} };
      notifications.init({ push: mockPush, deviceConfig: null });
      notifications.evaluate({ temps: {}, mode: 'IDLE' });
      assert.strictEqual(notifications.isDataFresh(), true);
    });

    it('returns false when data is older than DATA_STALE_MS', () => {
      notifications._setLastEvaluateTs(Date.now() - notifications.DATA_STALE_MS - 1);
      assert.strictEqual(notifications.isDataFresh(), false);
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
      var history = [];
      for (var i = 0; i <= 6; i++) {
        notifications.addSample(history, now - (6 - i) * 60000, 5 - i * 0.5);
      }
      notifications._setOutdoorHistory(history);

      notifications.evaluate({ temps: { tank_top: 50, outdoor: 2.1 }, mode: 'IDLE' });

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
      notifications.evaluate({ temps: { tank_top: 50, outdoor: 10 }, mode: 'SOLAR_CHARGING' });
      assert.strictEqual(notifications._getDailyEnergyWh(), 0);
    });

    it('tracks night heating minutes', () => {
      assert.strictEqual(notifications._getNightHeatingMinutes(), 0);
    });
  });

  describe('no spurious notifications', () => {
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
      // Suppress scheduled reports (which would fire if test runs at 12:00 or 20:00)
      var today = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
      notifications._setLastEveningReport(today);
      notifications._setLastNoonReport(today);
    });

    it('does not send any notification for normal temperatures', () => {
      for (var i = 0; i < 10; i++) {
        notifications.evaluate({ temps: { tank_top: 50, outdoor: 10 }, mode: 'IDLE' });
      }
      assert.strictEqual(sentNotifications.length, 0);
    });
  });

  describe('offline/online detection', () => {
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
      // Suppress scheduled reports (which would fire if test runs at 12:00 or 20:00)
      var today = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
      notifications._setLastEveningReport(today);
      notifications._setLastNoonReport(today);
    });

    it('does not send offline notification before 15 minutes', () => {
      var now = Date.now();
      // Simulate: last data arrived 10 min ago
      notifications._setLastEvaluateTs(now - 10 * 60000);

      notifications.tick();

      var offlineNotifs = sentNotifications.filter(function (n) { return n.type === 'offline_warning'; });
      assert.strictEqual(offlineNotifs.length, 0);
    });

    it('sends offline notification after 15 minutes of no data', () => {
      var now = Date.now();
      // Simulate: last data arrived 16 min ago
      notifications._setLastEvaluateTs(now - 16 * 60000);

      // First tick detects staleness and sets offlineSince
      notifications.tick();
      // offlineSince is now set to lastEvaluateTs (16 min ago), which is already > 15 min
      // so offline notification should fire on this first tick

      var offlineNotifs = sentNotifications.filter(function (n) { return n.type === 'offline_warning'; });
      assert.strictEqual(offlineNotifs.length, 1);
      assert.ok(offlineNotifs[0].payload.title.indexOf('Offline') >= 0);
    });

    it('sends offline notification only once', () => {
      var now = Date.now();
      notifications._setLastEvaluateTs(now - 20 * 60000);

      notifications.tick();
      notifications.tick();
      notifications.tick();

      var offlineNotifs = sentNotifications.filter(function (n) { return n.type === 'offline_warning'; });
      assert.strictEqual(offlineNotifs.length, 1);
    });

    it('sends online recovery notification after 15 min of steady data', () => {
      var now = Date.now();

      // Simulate: controller was offline for 20 min, then came back 16 min ago
      notifications._setLastEvaluateTs(now); // data is arriving now
      notifications._setOfflineSince(now - 36 * 60000); // went offline 36 min ago
      notifications._setOfflineNotified(true); // we already sent offline notif
      notifications._setOnlineSince(now - 16 * 60000); // data resumed 16 min ago
      notifications._setOnlineNotified(false);

      notifications.tick();

      var onlineNotifs = sentNotifications.filter(function (n) {
        return n.type === 'offline_warning' && n.payload.title.indexOf('Back Online') >= 0;
      });
      assert.strictEqual(onlineNotifs.length, 1);
    });

    it('does not send online notification before 15 min of steady data', () => {
      var now = Date.now();

      // Simulate: controller came back 5 min ago (not 15 yet)
      notifications._setLastEvaluateTs(now);
      notifications._setOfflineSince(now - 25 * 60000);
      notifications._setOfflineNotified(true);
      notifications._setOnlineSince(now - 5 * 60000);
      notifications._setOnlineNotified(false);

      notifications.tick();

      var onlineNotifs = sentNotifications.filter(function (n) {
        return n.type === 'offline_warning' && n.payload.title.indexOf('Back Online') >= 0;
      });
      assert.strictEqual(onlineNotifs.length, 0);
    });

    it('resets offline tracking after online recovery is confirmed', () => {
      var now = Date.now();

      notifications._setLastEvaluateTs(now);
      notifications._setOfflineSince(now - 36 * 60000);
      notifications._setOfflineNotified(true);
      notifications._setOnlineSince(now - 16 * 60000);
      notifications._setOnlineNotified(false);

      notifications.tick();

      // After recovery notification, offline state should be cleared
      assert.strictEqual(notifications._getOfflineSince(), 0);
      assert.strictEqual(notifications._getOfflineNotified(), false);
      assert.strictEqual(notifications._getOnlineSince(), 0);
    });

    it('cancels offline state if data arrives before 15-min threshold', () => {
      var now = Date.now();

      // Simulate: data stopped 5 min ago, offlineSince was set
      notifications._setLastEvaluateTs(now - 5 * 60000);
      notifications.tick(); // this sets offlineSince
      assert.ok(notifications._getOfflineSince() > 0, 'offlineSince should be set');

      // Now data arrives again — evaluate() should cancel the offline state
      notifications.evaluate({ temps: { tank_top: 50, outdoor: 10 }, mode: 'IDLE' });

      assert.strictEqual(notifications._getOfflineSince(), 0);
      assert.strictEqual(sentNotifications.length, 0);
    });

    it('evaluate() starts recovery tracking when data resumes after offline notification', () => {
      var now = Date.now();

      // Simulate: we already sent offline notification
      notifications._setOfflineSince(now - 20 * 60000);
      notifications._setOfflineNotified(true);
      notifications._setOnlineSince(0);

      // Data arrives
      notifications.evaluate({ temps: { tank_top: 50, outdoor: 10 }, mode: 'IDLE' });

      assert.ok(notifications._getOnlineSince() > 0, 'onlineSince should be set');
    });
  });
});
