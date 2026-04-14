// shelly/watchdogs-meta.js
//
// Watchdog metadata — shared between server and playground simulator.
// NOT concatenated into the device script by deploy.sh. The device
// only carries the three watchdog short ids (sng/scs/ggr) and a
// mapping to mode codes; all human-readable labels and TTLs live here.

// Uniform watchdog cool-off ban duration (4 hours). Mirrors
// DEFAULT_CONFIG.watchdogBanSeconds in shelly/control-logic.js — kept
// here so the server can compute the same ban timestamp without
// importing the full device script.
var WATCHDOG_BAN_SECONDS = 14400;

var WATCHDOGS = [
  {
    id: "sng",
    mode: "SOLAR_CHARGING",
    modeCode: "SC",
    label: "No tank gain",
    shortLabel: "Tank not heating",
    windowSeconds: 600,
    snoozeTtlSeconds: 7200
  },
  {
    id: "scs",
    mode: "SOLAR_CHARGING",
    modeCode: "SC",
    label: "Collector stuck",
    shortLabel: "Collector flow stuck",
    windowSeconds: 300,
    snoozeTtlSeconds: 3600
  },
  {
    id: "ggr",
    mode: "GREENHOUSE_HEATING",
    modeCode: "GH",
    label: "No greenhouse rise",
    shortLabel: "Greenhouse not warming",
    windowSeconds: 900,
    snoozeTtlSeconds: 43200
  }
];

var WATCHDOG_IDS = ["sng", "scs", "ggr"];

function getWatchdog(id) {
  for (var i = 0; i < WATCHDOGS.length; i++) {
    if (WATCHDOGS[i].id === id) return WATCHDOGS[i];
  }
  return null;
}

if (typeof module !== "undefined") {
  module.exports = {
    WATCHDOGS: WATCHDOGS,
    WATCHDOG_IDS: WATCHDOG_IDS,
    WATCHDOG_BAN_SECONDS: WATCHDOG_BAN_SECONDS,
    getWatchdog: getWatchdog
  };
}
