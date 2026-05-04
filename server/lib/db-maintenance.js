// Periodic db maintenance: incrementally extend the 30-second aggregate
// table + delete old raw data. Extracted from db.js to keep that file
// focused on the query API.
//
// Why incremental UPSERT (not REFRESH MATERIALIZED VIEW): the aggregate
// has to outlive raw retention (RETENTION_INTERVAL) so the 7d/30d/1y
// graph paths have data to draw. A REFRESH would rebuild from
// sensor_readings and lose every bucket older than 48 h. INSERT ... ON
// CONFLICT DO UPDATE adds new buckets without touching old ones.
//
// AGGREGATE_OVERLAP re-aggregates the boundary buckets — the most
// recent bucket may still be filling between maintenance runs. UPSERT
// makes the overlap idempotent.
//
// weather_forecasts: no retention policy yet — rows accumulate indefinitely.
// A 30-day cleanup will be added in a separate change once the fetcher lands.
// Do NOT add a DELETE here until that change is ready.
//
// spot_prices: preserved indefinitely (same rule as sensor_readings_30s) —
// cost-projection features need historical prices for back-analysis. Never add
// a retention DELETE or TRUNCATE against spot_prices.

const MAINTENANCE_INTERVAL = 30 * 60 * 1000; // 30 minutes
const INITIAL_DELAY = 60 * 1000;             // give the boot some breathing room
const RETENTION_INTERVAL = '48 hours';
const AGGREGATE_OVERLAP = '5 minutes';

const UPSERT_SQL =
  "INSERT INTO sensor_readings_30s (bucket, sensor_id, avg_value, min_value, max_value)\n" +
  "SELECT time_bucket('30 seconds', ts) AS bucket,\n" +
  "       sensor_id,\n" +
  "       AVG(value)::double precision,\n" +
  "       MIN(value)::double precision,\n" +
  "       MAX(value)::double precision\n" +
  "FROM sensor_readings\n" +
  "WHERE ts >= $1::timestamptz - INTERVAL '" + AGGREGATE_OVERLAP + "'\n" +
  "GROUP BY bucket, sensor_id\n" +
  "ON CONFLICT (bucket, sensor_id) DO UPDATE SET\n" +
  "  avg_value = EXCLUDED.avg_value,\n" +
  "  min_value = EXCLUDED.min_value,\n" +
  "  max_value = EXCLUDED.max_value";

const PROBE_SQL =
  "SELECT COALESCE(MAX(bucket), '1970-01-01'::timestamptz) AS max_bucket FROM sensor_readings_30s";

const DELETE_SQL =
  "DELETE FROM sensor_readings WHERE ts < NOW() - INTERVAL '" + RETENTION_INTERVAL + "'";

function create(getPool, log) {
  let timer = null;

  function run(callback) {
    const p = getPool();
    if (!p) { if (callback) callback(); return; }

    p.query(PROBE_SQL, [], function (probeErr, probe) {
      if (probeErr) {
        log.warn('aggregate probe failed', { error: probeErr.message });
        retention();
        return;
      }
      const since = probe.rows[0].max_bucket;
      p.query(UPSERT_SQL, [since], function (err) {
        if (err) {
          log.warn('aggregate upsert failed', { error: err.message });
        } else {
          log.info('aggregate upsert done', { since });
        }
        retention();
      });
    });

    function retention() {
      p.query(DELETE_SQL, [], function (err2) {
        if (err2) {
          log.warn('retention cleanup failed', { error: err2.message });
        } else {
          log.info('retention cleanup done');
        }
        if (callback) callback();
      });
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(run, MAINTENANCE_INTERVAL);
    setTimeout(run, INITIAL_DELAY);
    log.info('maintenance scheduler started', { intervalMin: MAINTENANCE_INTERVAL / 60000 });
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { run, start, stop };
}

// knip 6.x mis-resolves shorthand here; see server/auth/session.js for context.
// eslint-disable-next-line object-shorthand
module.exports = { create: create };
