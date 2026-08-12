-- Migration 003: production geofence foundation.
-- Adds location quality/idempotency, versioned circle policy, lifecycle state,
-- device credentials, command acknowledgements, and audit evidence.

-- Telemetry contract v2 (legacy columns remain for v1 compatibility).
ALTER TABLE telemetry ADD COLUMN message_id TEXT;
ALTER TABLE telemetry ADD COLUMN sequence INTEGER;
ALTER TABLE telemetry ADD COLUMN captured_at TEXT;
ALTER TABLE telemetry ADD COLUMN gps_accuracy_m REAL;
ALTER TABLE telemetry ADD COLUMN gps_hdop REAL;
ALTER TABLE telemetry ADD COLUMN gps_satellites INTEGER;
ALTER TABLE telemetry ADD COLUMN gps_heading REAL;
ALTER TABLE telemetry ADD COLUMN gps_altitude_m REAL;
ALTER TABLE telemetry ADD COLUMN gps_source TEXT;
ALTER TABLE telemetry ADD COLUMN motion_state TEXT;
ALTER TABLE telemetry ADD COLUMN ignition_state INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_message_id
    ON telemetry(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_telemetry_device_captured
    ON telemetry(device_id, captured_at DESC);

-- Extend existing circle zones without breaking v1 readers or bot commands.
ALTER TABLE geofence_zones ADD COLUMN zone_uuid TEXT;
ALTER TABLE geofence_zones ADD COLUMN zone_type TEXT NOT NULL DEFAULT 'circle';
ALTER TABLE geofence_zones ADD COLUMN policy_type TEXT NOT NULL DEFAULT 'safe';
ALTER TABLE geofence_zones ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE geofence_zones ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE geofence_zones ADD COLUMN exit_buffer_m REAL NOT NULL DEFAULT 10.0;
ALTER TABLE geofence_zones ADD COLUMN entry_buffer_m REAL NOT NULL DEFAULT 5.0;
ALTER TABLE geofence_zones ADD COLUMN confirm_samples INTEGER NOT NULL DEFAULT 2;
ALTER TABLE geofence_zones ADD COLUMN confirm_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE geofence_zones ADD COLUMN gps_accuracy_limit_m REAL NOT NULL DEFAULT 50.0;
ALTER TABLE geofence_zones ADD COLUMN schedule_json TEXT;
ALTER TABLE geofence_zones ADD COLUMN updated_at TEXT;

UPDATE geofence_zones
SET zone_uuid = 'gfz-' || printf('%08x', id),
    status = CASE WHEN is_active = 1 THEN 'active' ELSE 'paused' END,
    updated_at = COALESCE(updated_at, created_at)
WHERE zone_uuid IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_geofence_zone_uuid
    ON geofence_zones(zone_uuid);
CREATE INDEX IF NOT EXISTS idx_geofence_device_status
    ON geofence_zones(device_id, status, is_active);

CREATE TABLE IF NOT EXISTS geofence_zone_versions (
    zone_id              INTEGER NOT NULL,
    version              INTEGER NOT NULL,
    label                TEXT NOT NULL,
    zone_type            TEXT NOT NULL DEFAULT 'circle',
    policy_type          TEXT NOT NULL DEFAULT 'safe',
    anchor_lat           REAL NOT NULL,
    anchor_lon           REAL NOT NULL,
    radius_m             REAL NOT NULL,
    exit_buffer_m        REAL NOT NULL,
    entry_buffer_m       REAL NOT NULL,
    confirm_samples      INTEGER NOT NULL,
    confirm_seconds      INTEGER NOT NULL,
    gps_accuracy_limit_m REAL NOT NULL,
    schedule_json        TEXT,
    created_by           INTEGER,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (zone_id, version),
    FOREIGN KEY (zone_id) REFERENCES geofence_zones(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO geofence_zone_versions (
    zone_id, version, label, zone_type, policy_type,
    anchor_lat, anchor_lon, radius_m,
    exit_buffer_m, entry_buffer_m, confirm_samples, confirm_seconds,
    gps_accuracy_limit_m, schedule_json, created_at
)
SELECT
    id, version, label, zone_type, policy_type,
    anchor_lat, anchor_lon, radius_m,
    exit_buffer_m, entry_buffer_m, confirm_samples, confirm_seconds,
    gps_accuracy_limit_m, schedule_json, created_at
FROM geofence_zones;

CREATE TABLE IF NOT EXISTS device_zone_state (
    device_id          TEXT NOT NULL,
    zone_id            INTEGER NOT NULL,
    zone_version       INTEGER NOT NULL,
    state              TEXT NOT NULL DEFAULT 'UNKNOWN',
    candidate_count    INTEGER NOT NULL DEFAULT 0,
    candidate_since    TEXT,
    lifecycle_id       TEXT,
    last_distance_m    REAL,
    last_accuracy_m    REAL,
    last_classification TEXT,
    last_sample_at     TEXT,
    last_transition_at TEXT,
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (device_id, zone_id),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
    FOREIGN KEY (zone_id) REFERENCES geofence_zones(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS geofence_events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uuid         TEXT NOT NULL UNIQUE,
    lifecycle_id       TEXT NOT NULL,
    device_id          TEXT NOT NULL,
    zone_id            INTEGER NOT NULL,
    zone_version       INTEGER NOT NULL,
    transition         TEXT NOT NULL,
    state_from         TEXT,
    state_to           TEXT NOT NULL,
    gps_lat            REAL,
    gps_lon            REAL,
    distance_m         REAL,
    accuracy_m         REAL,
    evidence_json      TEXT,
    acknowledged_by    INTEGER,
    acknowledged_at    TEXT,
    occurred_at        TEXT NOT NULL,
    received_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
    FOREIGN KEY (zone_id) REFERENCES geofence_zones(id) ON DELETE CASCADE,
    FOREIGN KEY (acknowledged_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_geofence_events_device_time
    ON geofence_events(device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_geofence_events_lifecycle
    ON geofence_events(lifecycle_id, occurred_at);

CREATE TABLE IF NOT EXISTS device_credentials (
    device_id      TEXT NOT NULL,
    key_version    INTEGER NOT NULL DEFAULT 1,
    status         TEXT NOT NULL DEFAULT 'pending',
    last_sequence  INTEGER NOT NULL DEFAULT -1,
    activated_at   TEXT,
    revoked_at     TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (device_id, key_version),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO device_credentials (device_id, key_version, status)
SELECT device_id, 1, 'pending' FROM devices;

-- Atomically reject replayed v2 telemetry and advance the sequence only when
-- the telemetry insert itself succeeds. Legacy v1 packets have no sequence and
-- are unaffected during the compatibility window.
CREATE TRIGGER IF NOT EXISTS telemetry_v2_sequence_guard
BEFORE INSERT ON telemetry
WHEN NEW.sequence IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM device_credentials
        WHERE device_id = NEW.device_id
          AND status = 'active'
          AND NEW.sequence > last_sequence
    ) THEN RAISE(ABORT, 'device_sequence_rejected') END;

    UPDATE device_credentials
    SET last_sequence = NEW.sequence,
        updated_at = datetime('now')
    WHERE device_id = NEW.device_id
      AND status = 'active'
      AND NEW.sequence > last_sequence;
END;

ALTER TABLE device_commands ADD COLUMN acknowledged_at TEXT;
ALTER TABLE device_commands ADD COLUMN ack_status TEXT;
ALTER TABLE device_commands ADD COLUMN ack_payload_json TEXT;

CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id    TEXT NOT NULL,
    actor_type    TEXT NOT NULL,
    actor_id      TEXT NOT NULL,
    action        TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT,
    before_json   TEXT,
    after_json    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_resource_time
    ON audit_log(resource_type, resource_id, created_at DESC);
