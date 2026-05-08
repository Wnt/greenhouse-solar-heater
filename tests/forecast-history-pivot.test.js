'use strict';

/**
 * Tests for pivotHistory's outdoor-spike rejection.
 *
 * The outdoor sensor sits in a spot that catches direct sun for ~1 h
 * around 16:00 local time, reading several °C above the actual air
 * temperature for that window. Untreated, the spike contaminates the
 * τ_gh / α_solar / loss fits because the daytime portion of those
 * fits sees an anomalously warm "outdoor" that absorbs the radiation
 * signal — the fit then attributes daytime GH warming to outdoor
 * heating instead of solar gain, driving α_solar to its sanity-gate
 * floor. pivotHistory replaces sensor outdoor with the hour's
 * forecast value when the sensor exceeds it by more than the
 * threshold, so the fits run on clean data.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  _pivotHistory: pivotHistory,
  _OUTDOOR_SPIKE_THRESHOLD_C: SPIKE,
} = require('../server/lib/forecast/forecast-handler.js');

function ts(hour) { return new Date(Date.UTC(2026, 4, 8, hour, 0, 0)); }
function ts30(hour, min) { return new Date(Date.UTC(2026, 4, 8, hour, min, 0)); }

function row(sensorId, t, value) {
  return { ts: t.toISOString(), sensor_id: sensorId, value };
}

function wxRow(t, opts) {
  return {
    valid_at: t.toISOString(),
    radiation_global: opts.rad,
    temperature: opts.temp,
  };
}

describe('pivotHistory — outdoor spike rejection', () => {
  it('replaces a sensor reading that exceeds the forecast by more than the threshold', () => {
    // Forecast at 16:00 says outdoor is 18 °C; sensor reads 24 °C
    // (a 6 °C spike, far above the 2.5 °C threshold).
    const sensors = [
      row('greenhouse', ts(16), 30),
      row('outdoor',    ts(16), 24),
      row('tank_top',   ts(16), 35),
    ];
    const wx = [wxRow(ts(16), { rad: 500, temp: 18 })];
    const result = pivotHistory(sensors, [], wx, []);
    assert.equal(result.readings.length, 1);
    const r = result.readings[0];
    assert.equal(r.outdoor, 18, 'outdoor should be replaced with forecast');
    assert.equal(r._outdoorRaw, 24, 'raw spike preserved on _outdoorRaw');
  });

  it('keeps the sensor reading when the gap is within the threshold', () => {
    // Forecast 18 °C, sensor 19 °C — 1 °C gap, under threshold.
    const sensors = [
      row('greenhouse', ts(16), 30),
      row('outdoor',    ts(16), 19),
    ];
    const wx = [wxRow(ts(16), { rad: 500, temp: 18 })];
    const result = pivotHistory(sensors, [], wx, []);
    assert.equal(result.readings[0].outdoor, 19);
    assert.equal(result.readings[0]._outdoorRaw, undefined);
  });

  it('keeps the sensor reading when no forecast is available for the hour', () => {
    const sensors = [
      row('greenhouse', ts(16), 30),
      row('outdoor',    ts(16), 24),
    ];
    const result = pivotHistory(sensors, [], [], []);
    assert.equal(result.readings[0].outdoor, 24);
    assert.equal(result.readings[0]._outdoorRaw, undefined);
  });

  it('does not touch readings where sensor is colder than forecast', () => {
    // Sensor 12 °C, forecast 18 °C — sensor is 6 °C below; not a spike.
    const sensors = [
      row('greenhouse', ts(4), 8),
      row('outdoor',    ts(4), 12),
    ];
    const wx = [wxRow(ts(4), { rad: 0, temp: 18 })];
    const result = pivotHistory(sensors, [], wx, []);
    assert.equal(result.readings[0].outdoor, 12);
  });

  it('matches a 30-min reading to the closest hour-aligned forecast', () => {
    // Reading at 16:30, forecast at 16:00. Threshold is exceeded
    // → forecast value wins.
    const sensors = [
      row('greenhouse', ts30(16, 30), 30),
      row('outdoor',    ts30(16, 30), 24),
    ];
    const wx = [wxRow(ts(16), { rad: 500, temp: 18 })];
    const result = pivotHistory(sensors, [], wx, []);
    assert.equal(result.readings[0].outdoor, 18);
  });

  it('falls forward to the next hour when the floor hour has no forecast', () => {
    // Sensor at 15:45, no forecast at 15:00 but one at 16:00.
    const sensors = [
      row('greenhouse', ts30(15, 45), 30),
      row('outdoor',    ts30(15, 45), 24),
    ];
    const wx = [wxRow(ts(16), { rad: 500, temp: 18 })];
    const result = pivotHistory(sensors, [], wx, []);
    assert.equal(result.readings[0].outdoor, 18);
  });

  it('substitution kicks in exactly above the threshold, not at it', () => {
    // sensor = forecast + threshold → keep raw; sensor = forecast +
    // threshold + epsilon → substitute. Pin behaviour so future
    // threshold tweaks don't silently flip semantics.
    const baseT = 18;
    const atThreshold = baseT + SPIKE;
    const justAbove   = baseT + SPIKE + 0.1;

    const sensorsAt = [row('outdoor', ts(16), atThreshold)];
    const sensorsAbove = [row('outdoor', ts(16), justAbove)];
    const wx = [wxRow(ts(16), { rad: 500, temp: baseT })];

    const at = pivotHistory(sensorsAt, [], wx, []);
    const above = pivotHistory(sensorsAbove, [], wx, []);

    assert.equal(at.readings[0].outdoor, atThreshold,
      'at exactly threshold: raw value kept');
    assert.equal(above.readings[0].outdoor, baseT,
      'just above threshold: substituted with forecast');
  });
});
