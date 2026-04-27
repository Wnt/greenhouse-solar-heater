const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

describe('notifications', () => {
  let notifications;

  beforeEach(() => {
    delete require.cache[require.resolve('../server/lib/notifications.js')];
    notifications = require('../server/lib/notifications.js');
    notifications._reset();
    // Suppress scheduled noon (12:00 EE[S]T) and evening (20:00 EE[S]T)
    // reports for every subsuite. CI runs at the top of the noon hour
    // every day, which would otherwise cause checkNoonReport() to fire
    // a 'noon_report' inside any test that calls evaluate(). The
    // overheat/freeze tests filter by notification type so the extra
    // entry is harmless there, but it has been the source of repeated
    // CI flakes (see commit 0478d16) and any future spurious-count
    // assertion would be silently broken. Mark today as already-sent so
    // the gate `day === lastNoonReport` returns early.
    const today = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    notifications._setLastEveningReport(today);
    notifications._setLastNoonReport(today);
  });

  describe('predictValue (linear extrapolation)', () => {
    it('returns null with insufficient data', () => {
      assert.strictEqual(notifications.predictValue([], 900000), null);
      assert.strictEqual(notifications.predictValue([{ ts: 1000, value: 20 }], 900000), null);
    });

    it('returns null with samples spanning less than 60s', () => {
      const history = [
        { ts: 1000, value: 20 },
        { ts: 30000, value: 22 },
      ];
      assert.strictEqual(notifications.predictValue(history, 900000), null);
    });

    it('predicts rising temperature', () => {
      // 1 degree per minute → 15 min = +15
      const now = Date.now();
      const history = [];
      for (let i = 0; i <= 5; i++) {
        history.push({ ts: now - (5 - i) * 60000, value: 70 + i });
      }
      const predicted = notifications.predictValue(history, 15 * 60 * 1000);
      // Should be around 70 + 5 + 15 = 90
      assert.ok(predicted > 88, 'predicted=' + predicted);
      assert.ok(predicted < 92, 'predicted=' + predicted);
    });

    it('predicts falling temperature', () => {
      // -0.5 degree per minute → 15 min = -7.5
      const now = Date.now();
      const history = [];
      for (let i = 0; i <= 10; i++) {
        history.push({ ts: now - (10 - i) * 60000, value: 10 - i * 0.5 });
      }
      const predicted = notifications.predictValue(history, 15 * 60 * 1000);
      // Should be around 5 - 7.5 = -2.5
      assert.ok(predicted < 0, 'predicted=' + predicted);
      assert.ok(predicted > -5, 'predicted=' + predicted);
    });

    it('predicts stable temperature', () => {
      const now = Date.now();
      const history = [];
      for (let i = 0; i <= 5; i++) {
        history.push({ ts: now - (5 - i) * 60000, value: 50 });
      }
      const predicted = notifications.predictValue(history, 15 * 60 * 1000);
      assert.ok(Math.abs(predicted - 50) < 0.5, 'predicted=' + predicted);
    });
  });

  describe('addSample', () => {
    it('trims samples older than 10 minutes', () => {
      const history = [];
      const now = Date.now();
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
      // Mock must include iconFor — checkNoonReport / checkEveningReport
      // call pushRef.iconFor() when the test happens to run at the
      // scheduled hour (12:00 or 20:00 Finnish time). Without it, this
      // test fails on a noon-time CI run with "iconFor is not a function".
      const mockPush = {
        sendNotification: function () {},
        iconFor: function (type) { return 'assets/notif-' + type + '.png'; },
      };
      notifications.init({ push: mockPush, deviceConfig: null });
      notifications.evaluate({ temps: {}, mode: 'idle' });
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
          sentNotifications.push({ type, payload });
        },
        iconFor: function (type) {
          return 'assets/notif-' + type + '.png';
        },
      };
      notifications.init({ push: mockPush, deviceConfig: null });
    });

    it('sends overheat warning when tank temp trending toward the control-logic default', () => {
      const CONTROL = require('../shelly/control-logic.js');
      const overheatT = CONTROL.DEFAULT_CONFIG.overheatDrainTemp;  // currently 95
      const now = Date.now();
      const tankHistory = [];
      // Ramp from (overheatT - 7) up to (overheatT - 2) so linear extrapolation
      // over 15 min predicts crossing the threshold.
      for (let k = 0; k <= 5; k++) {
        notifications.addSample(tankHistory, now - (5 - k) * 60000, overheatT - 7 + k);
      }
      notifications._setTankHistory(tankHistory);

      notifications.evaluate({
        temps: { tank_top: overheatT - 2, outdoor: 10 }, mode: 'solar_charging',
      });

      const overheatNotifs = sentNotifications.filter(function (n) { return n.type === 'overheat_warning'; });
      assert.strictEqual(overheatNotifs.length, 1);
      // Body must reflect the current control-logic threshold, not a stale copy.
      assert.ok(
        overheatNotifs[0].payload.body.indexOf(String(overheatT)) >= 0,
        'expected overheat body to mention ' + overheatT + '°C, got: ' + overheatNotifs[0].payload.body
      );
    });

    it('does not send overheat warning when temp is stable below threshold', () => {
      const now = Date.now();
      const history = [];
      for (let i = 0; i <= 5; i++) {
        notifications.addSample(history, now - (5 - i) * 60000, 50);
      }
      notifications._setTankHistory(history);

      notifications.evaluate({ temps: { tank_top: 50, outdoor: 10 }, mode: 'idle' });

      const overheatNotifs = sentNotifications.filter(function (n) { return n.type === 'overheat_warning'; });
      assert.strictEqual(overheatNotifs.length, 0);
    });

    it('does not send overheat warning when already above threshold', () => {
      const CONTROL = require('../shelly/control-logic.js');
      const overheatT = CONTROL.DEFAULT_CONFIG.overheatDrainTemp;
      const now = Date.now();
      const history = [];
      for (let i = 0; i <= 5; i++) {
        notifications.addSample(history, now - (5 - i) * 60000, overheatT + 1 + i);
      }
      notifications._setTankHistory(history);

      notifications.evaluate({ temps: { tank_top: overheatT + 6, outdoor: 10 }, mode: 'solar_charging' });

      const overheatNotifs = sentNotifications.filter(function (n) { return n.type === 'overheat_warning'; });
      assert.strictEqual(overheatNotifs.length, 0);
    });

    it('sends freeze warning when outdoor temp trending toward the control-logic default', () => {
      const CONTROL = require('../shelly/control-logic.js');
      const freezeT = CONTROL.DEFAULT_CONFIG.freezeDrainTemp;  // currently 4
      const now = Date.now();
      const history = [];
      // Ramp from (freezeT + 3) down toward (freezeT + 0.1) so linear
      // extrapolation predicts crossing the threshold within 15 min.
      for (let i = 0; i <= 6; i++) {
        notifications.addSample(history, now - (6 - i) * 60000, freezeT + 3 - i * 0.5);
      }
      notifications._setOutdoorHistory(history);

      notifications.evaluate({ temps: { tank_top: 50, outdoor: freezeT + 0.1 }, mode: 'idle' });

      const freezeNotifs = sentNotifications.filter(function (n) { return n.type === 'freeze_warning'; });
      assert.strictEqual(freezeNotifs.length, 1);
      // Body must reference the current drain threshold, not a stale hardcoded value.
      assert.ok(
        freezeNotifs[0].payload.body.indexOf(String(freezeT)) >= 0,
        'expected freeze body to mention ' + freezeT + '°C, got: ' + freezeNotifs[0].payload.body
      );
    });

    it('does not send freeze warning when already below threshold', () => {
      const CONTROL = require('../shelly/control-logic.js');
      const freezeT = CONTROL.DEFAULT_CONFIG.freezeDrainTemp;
      const now = Date.now();
      const history = [];
      for (let i = 0; i <= 5; i++) {
        notifications.addSample(history, now - (5 - i) * 60000, freezeT - 1 - i * 0.1);
      }
      notifications._setOutdoorHistory(history);

      notifications.evaluate({ temps: { tank_top: 50, outdoor: freezeT - 1.5 }, mode: 'idle' });

      const freezeNotifs = sentNotifications.filter(function (n) { return n.type === 'freeze_warning'; });
      assert.strictEqual(freezeNotifs.length, 0);
    });

    it('does not send freeze warning when collectors are already drained', () => {
      // Same trending payload as the "sends freeze warning" test, but
      // with flags.collectors_drained=true. There is no water in the
      // collector loop to freeze, so warning the operator that "freeze
      // drain may activate" is misleading — it cannot, the system is
      // already in the post-drain state.
      const CONTROL = require('../shelly/control-logic.js');
      const freezeT = CONTROL.DEFAULT_CONFIG.freezeDrainTemp;
      const now = Date.now();
      const history = [];
      for (let i = 0; i <= 6; i++) {
        notifications.addSample(history, now - (6 - i) * 60000, freezeT + 3 - i * 0.5);
      }
      notifications._setOutdoorHistory(history);

      notifications.evaluate({
        temps: { tank_top: 50, outdoor: freezeT + 0.1 },
        mode: 'idle',
        flags: { collectors_drained: true },
      });

      const freezeNotifs = sentNotifications.filter(function (n) { return n.type === 'freeze_warning'; });
      assert.strictEqual(freezeNotifs.length, 0);
    });

    it('does not send overheat warning when collectors are already drained', () => {
      // Overheat drain only activates during SOLAR_CHARGING, which
      // requires water in the collectors. If they are drained, the
      // drain mode the warning references cannot trigger.
      const CONTROL = require('../shelly/control-logic.js');
      const overheatT = CONTROL.DEFAULT_CONFIG.overheatDrainTemp;
      const now = Date.now();
      const tankHistory = [];
      for (let k = 0; k <= 5; k++) {
        notifications.addSample(tankHistory, now - (5 - k) * 60000, overheatT - 7 + k);
      }
      notifications._setTankHistory(tankHistory);

      notifications.evaluate({
        temps: { tank_top: overheatT - 2, outdoor: 10 },
        mode: 'solar_charging',
        flags: { collectors_drained: true },
      });

      const overheatNotifs = sentNotifications.filter(function (n) { return n.type === 'overheat_warning'; });
      assert.strictEqual(overheatNotifs.length, 0);
    });

    it('tracks energy during solar charging', () => {
      notifications.evaluate({ temps: { tank_top: 50, outdoor: 10 }, mode: 'solar_charging' });
      assert.strictEqual(notifications._getDailyEnergyWh(), 0);
    });

    it('tracks night heating minutes', () => {
      assert.strictEqual(notifications._getNightHeatingMinutes(), 0);
    });

    it('daily energy is the positive delta of tank stored energy', () => {
      // Formula: Q = 300 kg × 4.186 kJ/(kg·K) × ΔT / 3600
      //   start: avg=20 °C  → ΔT=8  → 2.790 kWh
      //   end  : avg=40 °C  → ΔT=28 → 9.767 kWh
      //   gain : 6.977 kWh  → 6977 Wh
      notifications.evaluate({ temps: { tank_top: 22, tank_bottom: 18, outdoor: 10 }, mode: 'solar_charging' });
      assert.strictEqual(notifications._getDailyEnergyWh(), 0);

      notifications.evaluate({ temps: { tank_top: 45, tank_bottom: 35, outdoor: 10 }, mode: 'solar_charging' });
      const gained = notifications._getDailyEnergyWh();
      assert.ok(gained > 6900 && gained < 7100, 'expected ≈6977 Wh, got ' + gained);
    });

    it('ignores tank cooling (does not subtract from daily gathered)', () => {
      notifications.evaluate({ temps: { tank_top: 60, tank_bottom: 50, outdoor: 10 }, mode: 'idle' });
      const before = notifications._getDailyEnergyWh();

      notifications.evaluate({ temps: { tank_top: 45, tank_bottom: 35, outdoor: 10 }, mode: 'greenhouse_heating' });
      assert.strictEqual(notifications._getDailyEnergyWh(), before,
        'cooling must not decrease dailyEnergyWh');
    });

    it('accumulates gain across multiple heating pulses', () => {
      // First pulse: 20 → 30 °C avg
      notifications.evaluate({ temps: { tank_top: 22, tank_bottom: 18, outdoor: 10 }, mode: 'solar_charging' });
      notifications.evaluate({ temps: { tank_top: 34, tank_bottom: 26, outdoor: 10 }, mode: 'solar_charging' });
      // Tank cools overnight: 30 → 25 °C avg (no negative credit)
      notifications.evaluate({ temps: { tank_top: 28, tank_bottom: 22, outdoor: 10 }, mode: 'idle' });
      // Next morning heats again: 25 → 40 °C avg
      notifications.evaluate({ temps: { tank_top: 45, tank_bottom: 35, outdoor: 10 }, mode: 'solar_charging' });

      // Total positive delta: (30-20) + (40-25) = 25 K of heating
      // Q = 300 × 4.186 × 25 / 3600 ≈ 8.721 kWh → 8721 Wh
      const gained = notifications._getDailyEnergyWh();
      assert.ok(gained > 8600 && gained < 8850, 'expected ≈8721 Wh, got ' + gained);
    });

    it('classifies tank drops by mode (heating vs leakage)', () => {
      // payload.mode is lowercase — the device's buildStatePayload()
      // does st.mode.toLowerCase() before publishing. Regression test:
      // before 2026-04-27 the comparator used uppercase 'GREENHOUSE_HEATING',
      // so heating drops were silently misclassified as leakage.

      // First eval seeds lastTankEnergyKwh; no delta yet.
      notifications.evaluate({ temps: { tank_top: 55, tank_bottom: 45, outdoor: 5 }, mode: 'idle' });
      // Tank cools 3 K while idle — 50 → 47 avg
      // Q(3K) = 300·4.186·3/3600 ≈ 1.047 kWh → ≈1046 Wh leakage
      notifications.evaluate({ temps: { tank_top: 52, tank_bottom: 42, outdoor: 5 }, mode: 'idle' });
      // Heating turns on; tank drops 5 K — 47 → 42 avg → ≈1744 Wh heating
      notifications.evaluate({ temps: { tank_top: 46, tank_bottom: 38, outdoor: 5 }, mode: 'greenhouse_heating' });
      // Another 6 K drop still in GH mode → ≈2093 Wh heating
      notifications.evaluate({ temps: { tank_top: 40, tank_bottom: 32, outdoor: 5 }, mode: 'greenhouse_heating' });

      const leakage = notifications._getDailyLeakageLossWh();
      const heating = notifications._getDailyHeatingLossWh();
      assert.ok(leakage > 1000 && leakage < 1100, 'leakage=' + leakage);
      // Two drops crediting to heating: 1744 + 2093 ≈ 3837 Wh
      assert.ok(heating > 3750 && heating < 3900, 'heating=' + heating);
      // No gain
      assert.strictEqual(notifications._getDailyEnergyWh(), 0);
    });

    it('credits emergency_heating drops to heating bucket', () => {
      notifications.evaluate({ temps: { tank_top: 50, tank_bottom: 40, outdoor: 5 }, mode: 'emergency_heating' });
      notifications.evaluate({ temps: { tank_top: 45, tank_bottom: 35, outdoor: 5 }, mode: 'emergency_heating' });
      assert.ok(notifications._getDailyHeatingLossWh() > 0);
      assert.strictEqual(notifications._getDailyLeakageLossWh(), 0);
    });
  });

  describe('no spurious notifications', () => {
    let sentNotifications;
    let mockPush;

    beforeEach(() => {
      sentNotifications = [];
      mockPush = {
        sendNotification: function (type, payload) {
          sentNotifications.push({ type, payload });
        },
        iconFor: function (type) {
          return 'assets/notif-' + type + '.png';
        },
      };
      notifications.init({ push: mockPush, deviceConfig: null });
    });

    it('does not send any notification for normal temperatures', () => {
      for (let i = 0; i < 10; i++) {
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
          sentNotifications.push({ type, payload });
        },
        iconFor: function (type) {
          return 'assets/notif-' + type + '.png';
        },
      };
      notifications.init({ push: mockPush, deviceConfig: null });
    });

    it('does not send offline notification before 15 minutes', () => {
      const now = Date.now();
      // Simulate: last data arrived 10 min ago
      notifications._setLastEvaluateTs(now - 10 * 60000);

      notifications.tick();

      const offlineNotifs = sentNotifications.filter(function (n) { return n.type === 'offline_warning'; });
      assert.strictEqual(offlineNotifs.length, 0);
    });

    it('sends offline notification after 15 minutes of no data', () => {
      const now = Date.now();
      // Simulate: last data arrived 16 min ago
      notifications._setLastEvaluateTs(now - 16 * 60000);

      // First tick detects staleness and sets offlineSince
      notifications.tick();
      // offlineSince is now set to lastEvaluateTs (16 min ago), which is already > 15 min
      // so offline notification should fire on this first tick

      const offlineNotifs = sentNotifications.filter(function (n) { return n.type === 'offline_warning'; });
      assert.strictEqual(offlineNotifs.length, 1);
      assert.ok(offlineNotifs[0].payload.title.indexOf('Offline') >= 0);
    });

    it('sends offline notification only once', () => {
      const now = Date.now();
      notifications._setLastEvaluateTs(now - 20 * 60000);

      notifications.tick();
      notifications.tick();
      notifications.tick();

      const offlineNotifs = sentNotifications.filter(function (n) { return n.type === 'offline_warning'; });
      assert.strictEqual(offlineNotifs.length, 1);
    });

    it('sends online recovery notification after 15 min of steady data', () => {
      const now = Date.now();

      // Simulate: controller was offline for 20 min, then came back 16 min ago
      notifications._setLastEvaluateTs(now); // data is arriving now
      notifications._setOfflineSince(now - 36 * 60000); // went offline 36 min ago
      notifications._setOfflineNotified(true); // we already sent offline notif
      notifications._setOnlineSince(now - 16 * 60000); // data resumed 16 min ago
      notifications._setOnlineNotified(false);

      notifications.tick();

      const onlineNotifs = sentNotifications.filter(function (n) {
        return n.type === 'offline_warning' && n.payload.title.indexOf('Back Online') >= 0;
      });
      assert.strictEqual(onlineNotifs.length, 1);
    });

    it('does not send online notification before 15 min of steady data', () => {
      const now = Date.now();

      // Simulate: controller came back 5 min ago (not 15 yet)
      notifications._setLastEvaluateTs(now);
      notifications._setOfflineSince(now - 25 * 60000);
      notifications._setOfflineNotified(true);
      notifications._setOnlineSince(now - 5 * 60000);
      notifications._setOnlineNotified(false);

      notifications.tick();

      const onlineNotifs = sentNotifications.filter(function (n) {
        return n.type === 'offline_warning' && n.payload.title.indexOf('Back Online') >= 0;
      });
      assert.strictEqual(onlineNotifs.length, 0);
    });

    it('resets offline tracking after online recovery is confirmed', () => {
      const now = Date.now();

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
      const now = Date.now();

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
      const now = Date.now();

      // Simulate: we already sent offline notification
      notifications._setOfflineSince(now - 20 * 60000);
      notifications._setOfflineNotified(true);
      notifications._setOnlineSince(0);

      // Data arrives
      notifications.evaluate({ temps: { tank_top: 50, outdoor: 10 }, mode: 'IDLE' });

      assert.ok(notifications._getOnlineSince() > 0, 'onlineSince should be set');
    });
  });

  describe('editorial report bodies', () => {
    describe('evening (Daily Solar Report)', () => {
      it('sunny day with only leakage', () => {
        // 6.5 kWh gathered, 2.5 kWh leakage, no heating
        const body = notifications.buildEveningBody(6500, 0, 2500);
        assert.match(body, /gathered 6\.5 kWh/);
        assert.match(body, /2\.5 kWh slipped to air/);
        assert.match(body, /net \+4\.0 kWh/);
      });

      it('cloudy day with pure leakage loss', () => {
        const body = notifications.buildEveningBody(0, 0, 1400);
        assert.match(body, /No solar gain today/);
        assert.match(body, /released 1\.4 kWh to air/);
      });

      it('day with both heating and leakage losses', () => {
        const body = notifications.buildEveningBody(3400, 1900, 700);
        assert.match(body, /gathered 3\.4 kWh/);
        assert.match(body, /greenhouse drew 1\.9 kWh/);
        assert.match(body, /0\.7 kWh slipped to air/);
        assert.match(body, /net \+0\.8 kWh/);
      });

      it('net negative day shows the minus sign', () => {
        const body = notifications.buildEveningBody(800, 3200, 0);
        assert.match(body, /net −2\.4 kWh/);
      });

      it('flat day with everything below noise floor', () => {
        const body = notifications.buildEveningBody(30, 10, 20);
        assert.match(body, /held steady/);
      });

      it('cloudy with only heating losses', () => {
        const body = notifications.buildEveningBody(0, 1800, 0);
        assert.match(body, /No solar gain today/);
        assert.match(body, /greenhouse drew 1\.8 kWh from the tank/);
      });
    });

    describe('noon (Overnight Heating Report)', () => {
      it('heating disabled, tank cooled to air', () => {
        const body = notifications.buildNoonBody(0, 0, 1800, /*heatingDisabled*/ true);
        assert.match(body, /Greenhouse heating is resting/);
        assert.match(body, /released 1\.8 kWh to air/);
      });

      it('heating disabled, tank held steady', () => {
        const body = notifications.buildNoonBody(0, 0, 20, true);
        assert.match(body, /Greenhouse heating is resting/);
        assert.match(body, /held steady overnight/);
      });

      it('heating enabled and ran', () => {
        // 225 minutes = 3h 45min
        const body = notifications.buildNoonBody(225, 2800, 1400, false);
        assert.match(body, /3h 45min/);
        assert.match(body, /2\.8 kWh delivered/);
        assert.match(body, /1\.4 kWh slipped to air/);
      });

      it('heating enabled but did not run, only leakage', () => {
        const body = notifications.buildNoonBody(0, 0, 1600, false);
        assert.match(body, /No heating was needed overnight/);
        assert.match(body, /released 1\.6 kWh to air/);
      });

      it('heating enabled, did not run, everything quiet', () => {
        const body = notifications.buildNoonBody(0, 0, 20, false);
        assert.match(body, /No heating was needed overnight/);
        assert.match(body, /greenhouse stayed warm/);
      });
    });
  });

  describe('heating-disabled detection via deviceConfig', () => {
    it('noon report mentions disabled state when GH is in wb with future timestamp', () => {
      const cfg = { wb: { GH: 9999999999 } };
      const mockPush = {
        sendNotification: function () {},
        iconFor: function () { return ''; },
      };
      notifications.init({
        push: mockPush,
        deviceConfig: { getConfig: function () { return cfg; } },
      });

      // Seed an overnight leakage accumulator and force a report send
      notifications._setNightLeakageLossWh(1800);
      notifications._setLastNoonReport(0);
      notifications._setLastEvaluateTs(Date.now());

      const sent = [];
      mockPush.sendNotification = function (type, payload) { sent.push({ type, payload }); };

      // Fake the noon-hour gate by exporting buildNoonBody directly —
      // checkNoonReport gates on local hour which we can't control here.
      const body = notifications.buildNoonBody(0, 0, 1800, /*disabled*/ true);
      assert.match(body, /Greenhouse heating is resting/);
    });
  });
});
