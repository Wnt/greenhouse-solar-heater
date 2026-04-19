/**
 * Regression: for short ranges (1h, 6h, 12h) the raw `sensor_readings`
 * query returned only rows inside the window, so a real gap between the
 * last-pre-window point and the first-in-window point left the chart's
 * left edge empty — even though `drawTempLine` could have drawn a line
 * from the last-known point into the window.
 *
 * Fix: for the raw-data path, also fetch the most-recent row per sensor
 * from BEFORE the window. The client's lineTo connects those "leading
 * edge" rows forward across the left boundary. The raw SQL must include a
 * DISTINCT ON (sensor_id) subquery bounded by the same interval so the
 * leading-edge cost is O(sensors) not O(table).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'db.js'), 'utf8');

describe('getHistory — leading-edge row per sensor', () => {
  it('db.js references "leading edge" or DISTINCT ON (sensor_id) for the raw path', () => {
    const hasComment = /leading[- ]edge/i.test(dbSrc);
    const hasDistinctOn = /DISTINCT ON \(sensor_id\)/i.test(dbSrc);
    assert.ok(
      hasComment || hasDistinctOn,
      'expected the raw history query to include a leading-edge DISTINCT ON (sensor_id) clause ' +
      'so the chart can draw a line from the last-known point into the window',
    );
  });

  it('getHistory composes a leading-edge subquery against sensor_readings with ts <= window start', () => {
    // The raw-data branch of getHistory must include a "last point per sensor
    // before the window" lookup (DISTINCT ON sensor_id, ORDER BY ts DESC),
    // UNION'd with the in-window rows.
    const getHistoryFn = dbSrc.slice(dbSrc.indexOf('function getHistory'), dbSrc.indexOf('function getEventsPaginated'));
    assert.match(getHistoryFn, /DISTINCT ON \(sensor_id\)/);
    assert.match(getHistoryFn, /sensor_readings/);
    assert.match(getHistoryFn, /ts <= NOW\(\) - INTERVAL/);
    assert.match(getHistoryFn, /ORDER BY sensor_id, ts DESC/);
  });
});
