-- Migration 002: repair remaining FK references to users_old on all tables.
-- Run with: npx wrangler d1 execute bikeboss-db --remote --file=./migrations/002_fix_all_fks.sql

PRAGMA foreign_keys = OFF;

-- telemetry
CREATE TABLE telemetry_new (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id           TEXT NOT NULL,
    arm_state           INTEGER NOT NULL DEFAULT 0,
    gps_lat             REAL,
    gps_lon             REAL,
    gps_speed           REAL,
    gps_fix             INTEGER NOT NULL DEFAULT 0,
    imu_ax              REAL,
    imu_ay              REAL,
    imu_az              REAL,
    imu_gx              REAL,
    imu_gy              REAL,
    imu_gz              REAL,
    imu_atotal          REAL,
    imu_gtotal          REAL,
    vbat                REAL,
    crash_stage         INTEGER NOT NULL DEFAULT 0,
    geofence_active     INTEGER NOT NULL DEFAULT 0,
    geofence_anchor_lat REAL,
    geofence_anchor_lon REAL,
    received_at         TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);
INSERT INTO telemetry_new SELECT * FROM telemetry;
DROP TABLE telemetry;
ALTER TABLE telemetry_new RENAME TO telemetry;
CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON telemetry(device_id, received_at DESC);

-- events
CREATE TABLE events_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    severity     TEXT NOT NULL DEFAULT 'info',
    gps_lat      REAL,
    gps_lon      REAL,
    payload_json TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);
INSERT INTO events_new SELECT * FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX IF NOT EXISTS idx_events_device_time ON events(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(device_id, event_type, created_at DESC);

-- geofence_zones
CREATE TABLE geofence_zones_new (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id  TEXT NOT NULL,
    label      TEXT NOT NULL,
    anchor_lat REAL NOT NULL,
    anchor_lon REAL NOT NULL,
    radius_m   REAL NOT NULL DEFAULT 100.0,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);
INSERT INTO geofence_zones_new SELECT * FROM geofence_zones;
DROP TABLE geofence_zones;
ALTER TABLE geofence_zones_new RENAME TO geofence_zones;
CREATE INDEX IF NOT EXISTS idx_geofence_device ON geofence_zones(device_id, is_active);

-- payment_invoices
CREATE TABLE payment_invoices_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    device_id       TEXT,
    invoice_ref     TEXT NOT NULL UNIQUE,
    payway_txn_id   TEXT,
    amount_usd      REAL NOT NULL DEFAULT 15.00,
    status          TEXT NOT NULL DEFAULT 'pending',
    qr_code_data    TEXT,
    payway_response TEXT,
    expires_at      TEXT,
    paid_at         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE SET NULL
);
INSERT INTO payment_invoices_new SELECT * FROM payment_invoices;
DROP TABLE payment_invoices;
ALTER TABLE payment_invoices_new RENAME TO payment_invoices;
CREATE INDEX IF NOT EXISTS idx_payments_user ON payment_invoices(user_id, created_at DESC);

-- trips
CREATE TABLE trips_new (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id      TEXT NOT NULL,
    start_time     TEXT NOT NULL,
    end_time       TEXT,
    start_lat      REAL,
    start_lon      REAL,
    end_lat        REAL,
    end_lon        REAL,
    distance_km    REAL NOT NULL DEFAULT 0,
    max_speed_kmh  REAL NOT NULL DEFAULT 0,
    avg_speed_kmh  REAL NOT NULL DEFAULT 0,
    hard_brakes    INTEGER NOT NULL DEFAULT 0,
    harsh_accels   INTEGER NOT NULL DEFAULT 0,
    safety_score   INTEGER,
    eco_score      INTEGER,
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);
INSERT INTO trips_new SELECT * FROM trips;
DROP TABLE trips;
ALTER TABLE trips_new RENAME TO trips;
CREATE INDEX IF NOT EXISTS idx_trips_device ON trips(device_id, start_time DESC);

-- notification_log
CREATE TABLE notification_log_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER,
    device_id     TEXT,
    event_id      INTEGER,
    chat_id       TEXT NOT NULL,
    message_text  TEXT NOT NULL,
    sent          INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO notification_log_new SELECT * FROM notification_log;
DROP TABLE notification_log;
ALTER TABLE notification_log_new RENAME TO notification_log;

-- scoring_logs
CREATE TABLE scoring_logs_new (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id      TEXT NOT NULL,
    trip_id        INTEGER,
    score_type     TEXT NOT NULL,
    score_value    INTEGER NOT NULL,
    model_version  TEXT,
    input_features TEXT,
    computed_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL
);
INSERT INTO scoring_logs_new SELECT * FROM scoring_logs;
DROP TABLE scoring_logs;
ALTER TABLE scoring_logs_new RENAME TO scoring_logs;

-- device_commands
CREATE TABLE device_commands_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    command      TEXT NOT NULL,
    payload_json TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);
INSERT INTO device_commands_new SELECT * FROM device_commands;
DROP TABLE device_commands;
ALTER TABLE device_commands_new RENAME TO device_commands;
CREATE INDEX IF NOT EXISTS idx_commands_device ON device_commands(device_id, status, created_at);

PRAGMA foreign_keys = ON;
