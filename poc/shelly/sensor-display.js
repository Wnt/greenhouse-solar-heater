// ── Shelly Pro 4PM: Sensor Poll + Valve Control Script ──
// ES5-compatible. Polls DS18B20 sensors from Shelly 1 add-on,
// updates the Pro 4PM display, and controls valves on Pro 2PM.
//
// Deploy to Pro 4PM via: ./deploy-poc.sh
// Requires: Shelly 1 with sensor add-on at SENSOR_IP
//           Shelly Pro 2PM at VALVE_IP for valve relays

var SENSOR_IP = "192.168.1.86";
var SENSOR_IDS = [100, 101];
var SENSOR_NAMES = ["S1", "S2"];
var POLL_INTERVAL = 3; // seconds
var HTTP_TIMEOUT = 2; // seconds — must complete well within poll interval

var VALVE_IP = "192.168.1.136"; // Pro 2PM
var MIN_SWITCH_TIME = 30; // seconds — minimum time valve must stay in one state
var SETTLE_TIME = 15; // seconds — temps must stay crossed before switching

var DISPLAY_UPDATE_POLLS = 10; // update 4PM display every N polls (~30s)

var temps = {};
var lastPollOk = false;
var pollCount = 0;
var errorCount = 0;

// ── Valve state ──

var valves = {
  v1: { output: false, lastSwitchUptime: 0 },
  v2: { output: false, lastSwitchUptime: 0 }
};

var override = { active: false, v1: false, v2: false };

var settling = {
  active: false,
  desiredV1: false,
  desiredV2: false,
  sinceUptime: 0
};

function getUptime() {
  return Shelly.getComponentStatus("sys").uptime;
}

function canSwitch(valve) {
  var now = getUptime();
  return (now - valve.lastSwitchUptime) >= MIN_SWITCH_TIME;
}

function setValve(id, on, valve) {
  if (valve.output === on) return; // already in desired state
  if (!canSwitch(valve)) {
    print("Valve " + id + " cooldown active, skipping switch");
    return;
  }
  valve.output = on;
  valve.lastSwitchUptime = getUptime();
  var url = "http://" + VALVE_IP + "/rpc/Switch.Set?id=" + id + "&on=" + on;
  Shelly.call("HTTP.GET", { url: url, timeout: HTTP_TIMEOUT }, function (res, err) {
    if (err || !res || res.code !== 200) {
      print("Valve " + id + " switch error");
      errorCount++;
    } else {
      print("Valve " + id + " -> " + (on ? "OPEN" : "CLOSED"));
    }
  });
}

function applyValveLogic() {
  var s1 = temps["S1"];
  var s2 = temps["S2"];

  if (override.active) {
    // Override bypasses settling
    settling.active = false;
    setValve(0, override.v1, valves.v1);
    setValve(1, override.v2, valves.v2);
    return;
  }

  if (s1 === null || s1 === undefined || s2 === null || s2 === undefined) {
    return; // no data, keep current state
  }

  // Determine desired state from temperature comparison
  var wantV1, wantV2;
  if (s1 > s2) {
    wantV1 = true;
    wantV2 = false;
  } else if (s2 > s1) {
    wantV1 = false;
    wantV2 = true;
  } else {
    // Equal — no change desired, clear settling
    settling.active = false;
    return;
  }

  // Already in desired state?
  if (valves.v1.output === wantV1 && valves.v2.output === wantV2) {
    settling.active = false;
    return;
  }

  // Need to switch — apply settling delay
  var now = getUptime();

  if (!settling.active || settling.desiredV1 !== wantV1 || settling.desiredV2 !== wantV2) {
    // Start or restart settling (desired state changed)
    settling.active = true;
    settling.desiredV1 = wantV1;
    settling.desiredV2 = wantV2;
    settling.sinceUptime = now;
    print("Settling: temps crossed, waiting " + SETTLE_TIME + "s");
    return;
  }

  // Already settling for this desired state — check if enough time passed
  if ((now - settling.sinceUptime) < SETTLE_TIME) {
    return; // still waiting for readings to settle
  }

  // Settled! Apply the switch
  print("Settled: applying valve switch after " + SETTLE_TIME + "s");
  settling.active = false;
  setValve(0, wantV1, valves.v1);
  setValve(1, wantV2, valves.v2);
}

// ── Override control (called via Script.Eval from web UI) ──

function setOverride(v1, v2) {
  override.active = true;
  override.v1 = !!v1;
  override.v2 = !!v2;
  applyValveLogic();
  return JSON.stringify({ ok: true, override: override });
}

function clearOverride() {
  override.active = false;
  applyValveLogic();
  return JSON.stringify({ ok: true, override: override });
}

// ── Sensor polling ──

function pollSensor(idx, cb) {
  if (idx >= SENSOR_IDS.length) {
    cb();
    return;
  }
  var id = SENSOR_IDS[idx];
  var name = SENSOR_NAMES[idx];
  var url = "http://" + SENSOR_IP + "/rpc/Temperature.GetStatus?id=" + id;

  Shelly.call("HTTP.GET", { url: url, timeout: HTTP_TIMEOUT }, function (res, err) {
    if (res && res.code === 200) {
      try {
        var data = JSON.parse(res.body);
        temps[name] = data.tC;
      } catch (e) {
        temps[name] = null;
      }
    } else {
      temps[name] = null;
      errorCount++;
    }
    // Poll next sensor
    pollSensor(idx + 1, cb);
  });
}

function pollAll() {
  pollSensor(0, function () {
    pollCount++;
    lastPollOk = true;

    // Update switch names on the Pro 4PM display (throttled)
    if (pollCount % DISPLAY_UPDATE_POLLS === 0) {
      for (var i = 0; i < SENSOR_NAMES.length; i++) {
        var name = SENSOR_NAMES[i];
        var t = temps[name];
        var label;
        if (t !== null && t !== undefined) {
          label = name + " " + t.toFixed(1) + " C";
        } else {
          label = name + " --";
        }
        Shelly.call("Switch.SetConfig", {
          id: i,
          config: { name: label }
        }, function () {});
      }
    }

    // Apply valve logic after getting fresh temperatures
    applyValveLogic();
  });
}

// ── HTTP status endpoint ──

Shelly.addStatusHandler(function (event) {
  // No-op: just to keep script alive
});

function getStatus() {
  var now = getUptime();
  var v1Cooldown = Math.max(0, MIN_SWITCH_TIME - (now - valves.v1.lastSwitchUptime));
  var v2Cooldown = Math.max(0, MIN_SWITCH_TIME - (now - valves.v2.lastSwitchUptime));
  var settleElapsed = settling.active ? (now - settling.sinceUptime) : 0;
  var settleRemaining = settling.active ? Math.max(0, SETTLE_TIME - settleElapsed) : 0;
  return JSON.stringify({
    temps: temps,
    valves: {
      v1: { output: valves.v1.output, cooldownLeft: Math.round(v1Cooldown) },
      v2: { output: valves.v2.output, cooldownLeft: Math.round(v2Cooldown) }
    },
    override: override,
    settling: {
      active: settling.active,
      settleTime: SETTLE_TIME,
      elapsed: Math.round(settleElapsed),
      remaining: Math.round(settleRemaining)
    },
    minSwitchTime: MIN_SWITCH_TIME,
    pollCount: pollCount,
    errorCount: errorCount,
    lastPollOk: lastPollOk,
    uptimeS: now
  });
}

// ── Start ──

print("Sensor display + valve control script starting...");
print("Polling " + SENSOR_IDS.length + " sensors from " + SENSOR_IP + " every " + POLL_INTERVAL + "s");
print("Controlling valves on " + VALVE_IP);
print("Settle time: " + SETTLE_TIME + "s, min switch time: " + MIN_SWITCH_TIME + "s");

// Initial poll
pollAll();

// Recurring poll timer
Timer.set(POLL_INTERVAL * 1000, true, function () {
  pollAll();
});
