CREATE TABLE IF NOT EXISTS watchdog_events (
  id              BIGSERIAL PRIMARY KEY,
  watchdog_id     TEXT NOT NULL,
  mode            TEXT NOT NULL,
  fired_at        TIMESTAMPTZ NOT NULL,
  trigger_reason  TEXT NOT NULL,
  resolution      TEXT,
  resolved_at     TIMESTAMPTZ,
  snooze_until    TIMESTAMPTZ,
  snooze_reason   TEXT,
  resolved_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_watchdog_events_fired_at ON watchdog_events (fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_watchdog_events_watchdog_id ON watchdog_events (watchdog_id, fired_at DESC);
