// ── Shelly Pro 4PM: Sensor Poll + Display Script ──
// ES5-compatible. Polls DS18B20 sensors from Shelly 1 add-on
// and updates the Pro 4PM switch names on the display to show temperatures.
//
// Deploy to Pro 4PM via: ./deploy-poc.sh
// Requires: Shelly 1 with sensor add-on at SENSOR_IP

var SENSOR_IP = "192.168.1.86";
var SENSOR_IDS = [100, 101];
var SENSOR_NAMES = ["S1", "S2"];
var POLL_INTERVAL = 30; // seconds

var temps = {};
var lastPollOk = false;
var pollCount = 0;
var errorCount = 0;

// ── Sensor polling ──

function pollSensor(idx, cb) {
  if (idx >= SENSOR_IDS.length) {
    cb();
    return;
  }
  var id = SENSOR_IDS[idx];
  var name = SENSOR_NAMES[idx];
  var url = "http://" + SENSOR_IP + "/rpc/Temperature.GetStatus?id=" + id;

  Shelly.call("HTTP.GET", { url: url, timeout: 5 }, function (res, err) {
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

    // Update switch names on the Pro 4PM display (OUTPUT-0..3)
    // Each switch label is shown on the device screen
    var displayParts = [];
    for (var i = 0; i < SENSOR_NAMES.length; i++) {
      var name = SENSOR_NAMES[i];
      var t = temps[name];
      var label;
      if (t !== null && t !== undefined) {
        label = name + " " + t.toFixed(1) + " C";
      } else {
        label = name + " --";
      }
      displayParts.push(label);
      // Rename switch i to show the temperature
      Shelly.call("Switch.SetConfig", {
        id: i,
        config: { name: label }
      }, function () {});
    }

    print("Poll #" + pollCount + ": " + displayParts.join(" | "));
  });
}

// ── HTTP status endpoint ──
// Accessible at http://<PRO4PM_IP>/script/<ID>/status

Shelly.addStatusHandler(function (event) {
  // No-op: just to keep script alive
});

// Register an RPC handler so the web UI can query this device too
// Access via: http://<PRO4PM_IP>/rpc/Script.Eval?id=<SCRIPT_ID>&code=getStatus()
// This is a workaround since Shelly scripts can't register HTTP endpoints directly

function getStatus() {
  return JSON.stringify({
    temps: temps,
    pollCount: pollCount,
    errorCount: errorCount,
    lastPollOk: lastPollOk,
    uptimeS: Shelly.getComponentStatus("sys").uptime
  });
}

// ── Start ──

print("Sensor display script starting...");
print("Polling " + SENSOR_IDS.length + " sensors from " + SENSOR_IP);

// Initial poll
pollAll();

// Recurring poll timer
Timer.set(POLL_INTERVAL * 1000, true, function () {
  pollAll();
});
