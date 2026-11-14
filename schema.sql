-- Esquema para D1. Correr con:
--   npm run db:init         (local)
--   npm run db:init:remote  (producción)

CREATE TABLE IF NOT EXISTS licitaciones (
    dedupe_key    TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    source_id     TEXT,
    country       TEXT NOT NULL,
    entity        TEXT,
    title         TEXT,
    summary       TEXT,
    status        TEXT,
    publish_date  TEXT,              -- ISO date
    close_date    TEXT,              -- ISO datetime
    source_url    TEXT,
    categories    TEXT,              -- JSON array
    keywords_hit  TEXT,              -- JSON array
    raw           TEXT,              -- JSON blob original
    first_seen_at TEXT NOT NULL,     -- ISO datetime
    last_seen_at  TEXT NOT NULL      -- ISO datetime
);

CREATE INDEX IF NOT EXISTS idx_country    ON licitaciones(country);
CREATE INDEX IF NOT EXISTS idx_status     ON licitaciones(status);
CREATE INDEX IF NOT EXISTS idx_close_date ON licitaciones(close_date);
CREATE INDEX IF NOT EXISTS idx_source     ON licitaciones(source);
CREATE INDEX IF NOT EXISTS idx_first_seen ON licitaciones(first_seen_at);

-- Tabla de corridas: para debugging y dashboard
CREATE TABLE IF NOT EXISTS runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    source       TEXT NOT NULL,        -- fetcher name
    fetched      INTEGER DEFAULT 0,
    new_count    INTEGER DEFAULT 0,
    updated      INTEGER DEFAULT 0,
    unchanged    INTEGER DEFAULT 0,
    error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
