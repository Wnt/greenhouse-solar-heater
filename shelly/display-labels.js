// Display-label helpers for the control state — UI/reporting only.
//
// These deliberately do NOT live in shelly/control-logic.js. That file is
// uploaded to the Pro 4PM, where every top-level declaration costs ~85 B of the
// fixed 25,186 B JsVar pool whether or not it is ever called (measured on the
// spare Pro 2PM, 2026-08-12: 1 KB of source as ONE function = +84 B; the same
// 1 KB as 14 small functions = +1,274 B). control.js references none of these,
// so on the device they were pure overhead: removing them dropped the measured
// tick peak from 22,932 B to 22,386 B — more than the entire live headroom at
// the time (630 B).
//
// Same ES5 style as control-logic.js so this can move back onto a device (or
// into the browser bundle) unchanged if something ever needs it there.

// The one value this module needs from control-logic.js. Inlined rather than
// imported so requiring the display helpers never pulls the device file into
// the module graph; tests/control-logic-display.test.js pins it equal to
// MODES.IDLE so a rename there cannot silently drift from this copy.
var IDLE_MODE = "IDLE";

var MODE_SHORT = {
  IDLE: "IDLE",
  SOLAR_CHARGING: "SOLAR",
  GREENHOUSE_HEATING: "HEAT",
  ACTIVE_DRAIN: "DRAIN",
  EMERGENCY_HEATING: "EMERG",
};

function formatDuration(ms) {
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60);
  return h + "h" + (m % 60) + "m";
}

function formatTemp(t) {
  if (t === null || t === undefined) return "--";
  return Math.round(t) + "C";
}

function buildDisplayLabels(displayState) {
  var dur = formatDuration(displayState.modeDurationMs);
  var prefix = MODE_SHORT[displayState.mode] || displayState.mode;
  var ch0 = prefix + " " + dur;
  if (displayState.lastError) ch0 = "!" + ch0;
  if (displayState.collectorsDrained && displayState.mode === IDLE_MODE) ch0 = ch0 + " D";

  var t = displayState.temps;
  var ch1 = "Coll " + formatTemp(t.collector)
    + " Tk" + formatTemp(t.tank_top)
    + "/" + formatTemp(t.tank_bottom);
  var ch2 = "GH " + formatTemp(t.greenhouse);
  var ch3 = "Out " + formatTemp(t.outdoor);

  return [ch0, ch1, ch2, ch3];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MODE_SHORT: MODE_SHORT,
    formatDuration: formatDuration,
    formatTemp: formatTemp,
    buildDisplayLabels: buildDisplayLabels,
    IDLE_MODE: IDLE_MODE
  };
}
