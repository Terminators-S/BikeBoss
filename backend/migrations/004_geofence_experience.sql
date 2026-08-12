-- Migration 004: command UX, owner-presence evidence and smart-zone suggestions.
-- Apply to staging first:
--   npx wrangler d1 execute bikeboss-db-staging --env staging --remote --file=./migrations/004_geofence_experience.sql

ALTER TABLE telemetry ADD COLUMN owner_presence_connected INTEGER;
ALTER TABLE telemetry ADD COLUMN owner_presence_authenticated INTEGER;
ALTER TABLE telemetry ADD COLUMN owner_presence_age_s INTEGER;
ALTER TABLE telemetry ADD COLUMN owner_presence_confidence REAL;

ALTER TABLE geofence_events ADD COLUMN alert_suppressed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE geofence_events ADD COLUMN suppression_reason TEXT;
ALTER TABLE geofence_events ADD COLUMN owner_presence_json TEXT;

CREATE TABLE IF NOT EXISTS place_suggestions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    suggestion_uuid    TEXT NOT NULL UNIQUE,
    device_id           TEXT NOT NULL,
    fingerprint         TEXT NOT NULL,
    suggested_name      TEXT NOT NULL DEFAULT 'Frequent parking place',
    center_lat          REAL NOT NULL,
    center_lon          REAL NOT NULL,
    suggested_radius_m  REAL NOT NULL,
    sample_count        INTEGER NOT NULL,
    distinct_days       INTEGER NOT NULL,
    first_seen_at       TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    confidence          REAL NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',
    model_version       TEXT NOT NULL DEFAULT 'parking-cluster-v1',
    accepted_zone_uuid  TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
    UNIQUE(device_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_place_suggestions_device_status
    ON place_suggestions(device_id, status, confidence DESC);
