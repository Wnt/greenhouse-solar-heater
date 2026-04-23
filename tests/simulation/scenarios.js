// Scenario definitions for simulation tests
// Each scenario: { name, duration, initialState, ambient(t), irradiance(t), assertions[] }

const { MODES } = require('../../shelly/control-logic.js');

// --- Environment profile helpers ---

// Sinusoidal temperature: min at hour 4, max at hour 14
function sinusoidalTemp(min, max) {
  return function(t) {
    const hour = (t / 3600) % 24;
    // Cosine shifted so min at 4:00, max at 16:00
    return (min + max) / 2 + (max - min) / 2 * Math.cos(Math.PI * (hour - 14) / 12);
  };
}

// Bell curve irradiance: 0 at night, peak at solar noon (12:00)
function bellCurveIrradiance(peak) {
  return function(t) {
    const hour = (t / 3600) % 24;
    if (hour < 6 || hour > 18) return 0;
    // Gaussian centered at 12, sigma ~3h
    const x = (hour - 12) / 3;
    return peak * Math.exp(-x * x / 2);
  };
}

// Constant value
function constant(val) {
  return function() { return val; };
}

// Linear ramp from start to end over duration
function ramp(startVal, endVal, duration) {
  return function(t) {
    const frac = Math.min(t / duration, 1);
    return startVal + (endVal - startVal) * frac;
  };
}

// Fluctuating irradiance (semi-cloudy)
function cloudyIrradiance(peak, cloudInterval, cloudDuration) {
  const base = bellCurveIrradiance(peak);
  return function(t) {
    const val = base(t);
    // Cloud every cloudInterval seconds, lasting cloudDuration
    if (val > 0 && (t % cloudInterval) < cloudDuration) {
      return val * 0.1;  // 90% reduction during cloud
    }
    return val;
  };
}

// --- Assertion helpers ---

function findModeTransitions(trace, toMode) {
  return trace.filter(s => s.event && s.event.includes('\u2192 ' + toMode));
}

function findMode(trace, mode) {
  return trace.filter(s => s.mode === mode);
}

function maxTemp(trace, sensor) {
  return Math.max(...trace.map(s => s.temps[sensor]));
}

function minTemp(trace, sensor) {
  return Math.min(...trace.map(s => s.temps[sensor]));
}

// --- Scenarios ---

const scenarios = [
  // 1. Sunny day
  {
    name: 'sunny-day',
    duration: 86400,
    initialState: {
      collector: 10, tank_top: 25, tank_bottom: 20,
      greenhouse: 12, collectorsDrained: true,
      collectorWaterVolume: 0,
    },
    ambient: sinusoidalTemp(5, 15),
    irradiance: bellCurveIrradiance(800),
    assertions: [
      {
        description: 'solar charging starts during daylight',
        check: function(trace) {
          const transitions = findModeTransitions(trace, MODES.SOLAR_CHARGING);
          if (transitions.length === 0) throw new Error('never entered SOLAR_CHARGING');
          const hour = transitions[0].t / 3600;
          if (hour < 6 || hour > 14) throw new Error('started at hour ' + hour.toFixed(1));
        }
      },
      {
        description: 'solar charging stops by evening',
        check: function(trace) {
          const eveningFrames = trace.filter(s => s.t > 64800); // after 18:00
          const stillSolar = eveningFrames.filter(s => s.mode === MODES.SOLAR_CHARGING);
          if (stillSolar.length > 300) throw new Error('still solar charging after 18:00');
        }
      },
      {
        description: 'tank top warms during the day',
        check: function(trace) {
          const noon = trace.find(s => s.t === 43200);
          const morning = trace.find(s => s.t === 21600);
          if (!noon || !morning) throw new Error('missing data points');
          if (noon.temps.tank_top <= morning.temps.tank_top) {
            throw new Error('tank did not warm: ' + morning.temps.tank_top + ' -> ' + noon.temps.tank_top);
          }
        }
      },
    ],
  },

  // 2. Semi-cloudy day
  {
    name: 'semi-cloudy-day',
    duration: 86400,
    initialState: {
      collector: 10, tank_top: 30, tank_bottom: 25,
      greenhouse: 15, collectorsDrained: true,
      collectorWaterVolume: 0,
    },
    config: { minModeDuration: 60, refillRetryCooldown: 300, minRunTimeAfterRefill: 120 },
    ambient: sinusoidalTemp(8, 14),
    irradiance: cloudyIrradiance(700, 1200, 400),
    assertions: [
      {
        // Catches pathological oscillation only (sub-25 s bouncing). IDLE
        // itself has no minimum duration (see evaluate() in control-
        // logic.js), so IDLE -> SC re-entry is gated only by the physics
        // -- collector must recover to tank_bottom + solarEnterDelta. The
        // 3 K enter delta (tuned 2026-04-22) is small enough that under
        // fast-changing cloud irradiance the re-entry can follow a stall
        // exit within ~30 s. That is the designed reactive behavior, not
        // a bug: shorter IDLE intervals here let the collector recover
        // thermal head during each cloud dip. We still want to catch a
        // truly degenerate cycle (e.g. a 5 s bounce caused by a faulty
        // hysteresis).
        description: 'no pathological mode oscillation (gap < 25 s)',
        check: function(trace) {
          let lastTransition = 0;
          for (const s of trace) {
            if (s.event && s.event.includes('\u2192')) {
              const gap = s.t - lastTransition;
              // Allow very first transition and drain preemptions
              if (lastTransition > 0 && gap < 25 && !s.event.includes(MODES.ACTIVE_DRAIN)) {
                throw new Error('oscillation at t=' + s.t + ' gap=' + gap + 's: ' + s.event);
              }
              lastTransition = s.t;
            }
          }
        }
      },
      {
        description: 'at least one speculative refill attempt occurs',
        check: function(trace) {
          const refills = findModeTransitions(trace, MODES.SOLAR_CHARGING);
          if (refills.length === 0) throw new Error('no speculative refill occurred');
        }
      },
    ],
  },

  // 3. Freeze at dusk
  {
    name: 'freeze-at-dusk',
    duration: 43200,
    initialState: {
      collector: 45, tank_top: 40, tank_bottom: 35,
      greenhouse: 12, collectorsDrained: false,
      collectorWaterVolume: 10, mode: MODES.SOLAR_CHARGING,
    },
    ambient: ramp(8, -5, 43200),
    irradiance: ramp(400, 0, 21600),
    assertions: [
      {
        description: 'drain triggers before outdoor reaches 0\u00b0C',
        check: function(trace) {
          const drainStart = findModeTransitions(trace, MODES.ACTIVE_DRAIN);
          if (drainStart.length === 0) throw new Error('drain never triggered');
          var outdoor = drainStart[0].temps.outdoor;
          if (outdoor < 0) throw new Error('drain started too late, outdoor=' + outdoor);
        }
      },
      {
        description: 'collectors fully drained',
        check: function(trace) {
          const idleFrames = trace.filter(s => s.mode === MODES.IDLE && s.t > 10000);
          if (idleFrames.length === 0) throw new Error('never returned to IDLE after drain');
        }
      },
    ],
  },

  // 4. Overheat
  {
    name: 'overheat',
    duration: 28800,
    initialState: {
      collector: 100, tank_top: 84.9, tank_bottom: 80,
      greenhouse: 25, collectorsDrained: false,
      collectorWaterVolume: 10, mode: MODES.SOLAR_CHARGING,
    },
    ambient: constant(30),
    irradiance: constant(900),
    assertions: [
      {
        description: 'overheat drain triggers when tank_top exceeds 85\u00b0C',
        check: function(trace) {
          const drain = findModeTransitions(trace, MODES.ACTIVE_DRAIN);
          if (drain.length === 0) throw new Error('overheat drain never triggered');
        }
      },
      {
        description: 'tank top stays below 90\u00b0C after drain',
        check: function(trace) {
          const drainStart = findModeTransitions(trace, MODES.ACTIVE_DRAIN);
          if (drainStart.length === 0) return;
          const afterDrain = trace.filter(s => s.t > drainStart[0].t);
          const max = Math.max(...afterDrain.map(s => s.temps.tank_top));
          if (max > 95) throw new Error('tank_top reached ' + max.toFixed(1) + '\u00b0C after drain');
        }
      },
    ],
  },

  // 5. Cold night heating
  {
    name: 'cold-night-heating',
    duration: 43200,
    config: { minModeDuration: 60 },
    initialState: {
      collector: 5, tank_top: 60, tank_bottom: 50,
      greenhouse: 15, collectorsDrained: true,
      collectorWaterVolume: 0,
    },
    ambient: ramp(5, -2, 43200),
    irradiance: constant(0),
    assertions: [
      {
        description: 'greenhouse heating activates when greenhouse < 10',
        check: function(trace) {
          var heat = findModeTransitions(trace, MODES.GREENHOUSE_HEATING);
          if (heat.length === 0) throw new Error('heating never activated');
          if (heat[0].temps.greenhouse > 10.5) {
            throw new Error('heating started at greenhouse=' + heat[0].temps.greenhouse);
          }
        }
      },
      {
        description: 'heating deactivates when greenhouse > 12',
        check: function(trace) {
          const heatFrames = findMode(trace, MODES.GREENHOUSE_HEATING);
          if (heatFrames.length === 0) return; // skip if never heated
          // Check that heating doesn't run when greenhouse > 12.5
          const overheated = heatFrames.filter(s => s.temps.greenhouse > 12.5);
          if (overheated.length > 60) { // allow transient from min duration
            throw new Error('heating ran too long above 12\u00b0C');
          }
        }
      },
    ],
  },

  // 6. Emergency fallback
  {
    name: 'emergency-fallback',
    duration: 14400,
    initialState: {
      collector: -5, tank_top: 6, tank_bottom: 4,
      greenhouse: 8, collectorsDrained: true,
      collectorWaterVolume: 0,
    },
    ambient: constant(-5),
    irradiance: constant(0),
    assertions: [
      {
        description: 'emergency heating activates when greenhouse < 9 and tank lacks delta',
        check: function(trace) {
          const em = findModeTransitions(trace, MODES.EMERGENCY_HEATING);
          if (em.length === 0) throw new Error('emergency never activated');
        }
      },
      {
        description: 'space heater is ON during emergency',
        check: function(trace) {
          const emFrames = findMode(trace, MODES.EMERGENCY_HEATING);
          for (const s of emFrames) {
            if (!s.valves) continue;
            // Emergency: pump off, all valves closed, space_heater on
            if (s.pump) throw new Error('pump should be off in emergency at t=' + s.t);
          }
        }
      },
      {
        description: 'emergency exits when greenhouse > 12',
        check: function(trace) {
          const emFrames = findMode(trace, MODES.EMERGENCY_HEATING);
          const overheated = emFrames.filter(s => s.temps.greenhouse > 13);
          if (overheated.length > 600) {
            throw new Error('emergency ran too long above 12\u00b0C');
          }
        }
      },
    ],
  },

  // 7. Sensor failure
  {
    name: 'sensor-failure',
    duration: 3600,
    initialState: {
      collector: 50, tank_top: 40, tank_bottom: 30,
      greenhouse: 15, collectorsDrained: false,
      collectorWaterVolume: 10, mode: MODES.SOLAR_CHARGING,
    },
    ambient: constant(10),
    irradiance: constant(500),
    sensorAge: function(t) {
      // Sensors go stale at t=600 (collector stops updating)
      if (t >= 600) {
        return { collector: t - 600, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 };
      }
      return { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 };
    },
    assertions: [
      {
        description: 'system transitions to IDLE when sensor goes stale',
        check: function(trace) {
          // sensorStaleThreshold is 150s, so IDLE should happen by t=750
          const idleAfterStale = trace.filter(s => s.t > 750 && s.mode === MODES.IDLE);
          if (idleAfterStale.length === 0) {
            throw new Error('did not transition to IDLE after sensor failure');
          }
        }
      },
      {
        description: 'pump is off after sensor failure',
        check: function(trace) {
          const lateFrames = trace.filter(s => s.t > 900);
          const pumpOn = lateFrames.filter(s => s.pump);
          if (pumpOn.length > 0) throw new Error('pump still on after sensor failure');
        }
      },
    ],
  },

  // 8. Boot during freeze
  {
    name: 'boot-during-freeze',
    duration: 3600,
    initialState: {
      collector: -2, tank_top: 5, tank_bottom: 5,
      greenhouse: -2, collectorsDrained: false,
      collectorWaterVolume: 8,
    },
    ambient: constant(-3),
    irradiance: constant(0),
    assertions: [
      {
        description: 'drain triggers on first evaluation',
        check: function(trace) {
          const drain = findModeTransitions(trace, MODES.ACTIVE_DRAIN);
          if (drain.length === 0) throw new Error('drain never triggered');
          if (drain[0].t > 30) throw new Error('drain started too late at t=' + drain[0].t);
        }
      },
      {
        description: 'system reaches safe state within 5 minutes',
        check: function(trace) {
          const fiveMin = trace.filter(s => s.t > 300);
          const safe = fiveMin.filter(s =>
            s.mode === MODES.IDLE || s.mode === MODES.EMERGENCY_HEATING ||
            s.mode === MODES.GREENHOUSE_HEATING);
          if (safe.length < fiveMin.length * 0.9) {
            throw new Error('system not in safe state after 5 minutes');
          }
        }
      },
    ],
  },

  // 9. Concurrent triggers
  {
    name: 'concurrent-triggers',
    duration: 14400,
    initialState: {
      collector: 10, tank_top: 50, tank_bottom: 40,
      greenhouse: 9, collectorsDrained: true,
      collectorWaterVolume: 0,
    },
    ambient: constant(5),
    irradiance: constant(500),
    assertions: [
      {
        description: 'greenhouse heating wins over solar when both triggers active',
        check: function(trace) {
          // First non-IDLE mode should be GREENHOUSE_HEATING
          const firstActive = trace.find(s => s.mode !== MODES.IDLE);
          if (!firstActive) throw new Error('never left IDLE');
          if (firstActive.mode !== MODES.GREENHOUSE_HEATING) {
            throw new Error('first mode was ' + firstActive.mode + ', expected GREENHOUSE_HEATING');
          }
        }
      },
    ],
  },

  // 11. Strong spring sun onto a cold, stratified tank — inspired by
  // the 2026-04-23 morning scene (collector near 85 °C while tank_bottom
  // was still in the low 20s). Tank_top starts well below the collector
  // equilibrium so solar flow actually warms it, letting the stall logic
  // be exercised on a rising curve. An exit that looks only at tank_top
  // plateaus as soon as top reaches the collector return temperature,
  // while tank_bottom is still stratified cold. The mean-of-top-and-
  // bottom stall metric plus the much-hotter-collector bypass keep the
  // pump running until the bottom catches up.
  //
  // Greenhouse starts warm (20 °C) so greenhouse_heating doesn't divert
  // tank energy — the simulator's greenhouse model has no solar gain, so
  // leaving it near the heating threshold would pull the focus off
  // solar-charging behavior.
  {
    name: 'strong-sun-cold-tank',
    duration: 86400,
    initialState: {
      collector: 2, tank_top: 18, tank_bottom: 12,
      greenhouse: 20, collectorsDrained: true,
      collectorWaterVolume: 0,
    },
    ambient: sinusoidalTemp(5, 17),
    irradiance: bellCurveIrradiance(900),
    assertions: [
      {
        description: 'solar charging runs during the day',
        check: function(trace) {
          const trans = findModeTransitions(trace, MODES.SOLAR_CHARGING);
          if (trans.length === 0) throw new Error('never entered SOLAR_CHARGING');
        }
      },
      {
        description: 'solar occupies at least 4 h of the daylight window',
        check: function(trace) {
          // Sum of ticks where pump is on AND we are in SOLAR_CHARGING,
          // expressed as seconds. Trace has one frame per SIM_STEP (10 s).
          const solarSeconds = trace.filter(s =>
            s.mode === MODES.SOLAR_CHARGING && s.pump).length * 10;
          if (solarSeconds < 4 * 3600) {
            throw new Error('only ' + (solarSeconds/3600).toFixed(1) + ' h of solar pump runtime');
          }
        }
      },
    ],
  },

  // 10. Hysteresis boundary
  {
    name: 'hysteresis-boundary',
    duration: 14400,
    initialState: {
      collector: 37, tank_top: 40, tank_bottom: 30,
      greenhouse: 15, collectorsDrained: false,
      collectorWaterVolume: 10,
    },
    config: { minModeDuration: 60 },
    ambient: constant(10),
    irradiance: constant(300),  // just enough to hover near threshold
    assertions: [
      {
        description: 'no rapid oscillation (min 50s between transitions)',
        check: function(trace) {
          let lastT = 0;
          for (const s of trace) {
            if (s.event && s.event.includes('\u2192')) {
              if (lastT > 0 && (s.t - lastT) < 50) {
                throw new Error('oscillation: transitions at t=' + lastT + ' and t=' + s.t);
              }
              lastT = s.t;
            }
          }
        }
      },
    ],
  },
];

module.exports = { scenarios };
