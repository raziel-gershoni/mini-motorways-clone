CREATE TABLE IF NOT EXISTS results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  platform    TEXT,
  perf_class  TEXT,
  dpr         REAL,
  ua          TEXT,
  body        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_results_received_at ON results (received_at DESC);
