-- =============================================================================
-- BikeBoss — Cloudflare D1 Database Schema (v2)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. USERS — Telegram user accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     TEXT NOT NULL UNIQUE,
    telegram_handle TEXT,
    phone_number    TEXT,
    display_name    TEXT NOT NULL,
    language        TEXT NOT NULL DEFAULT 'en',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- 2. DEVICES — Registered BikeBoss hardware units
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id           TEXT NOT NULL UNIQUE,          -- e.g., "BB-00000001"
    owner_id            INTEGER,                       -- FK → users.id (NULL = unclaimed)
    vehicle_plate       TEXT,
    vehicle_model       TEXT,
    vehicle_year        INTEGER,
    install_mode        TEXT NOT NULL DEFAULT 'universal',  -- universal | scooter_solenoid
    data_sim_iccid      TEXT,
    data_sim_expiry     TEXT,
    subscription_expiry TEXT,
    firmware_ver        TEXT NOT NULL DEFAULT '1.0.0',
    is_active           INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner_id);

-- ---------------------------------------------------------------------------
-- 3. TELEMETRY — Incoming heartbeat & telemetry packets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id           TEXT NOT NULL,
    arm_state           INTEGER NOT NULL DEFAULT 0,    -- 0=disarmed, 1=armed, 2=pending
    gps_lat             REAL,
    gps_lon             REAL,
    gps_speed           REAL,                          -- km/h
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
    crash_stage         INTEGER NOT NULL DEFAULT 0,    -- 0..4
    geofence_active     INTEGER NOT NULL DEFAULT 0,
    geofence_anchor_lat REAL,
    geofence_anchor_lon REAL,
    received_at         TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telemetry_device_time
    ON telemetry(device_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- 4. EVENTS — Historical incidents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    event_type   TEXT NOT NULL,          -- CRASH, POWER_CUT, GEOFENCE_BREACH,
                                         -- MOTION_SIGNAL_LOSS, HEARTBEAT_TIMEOUT,
                                         -- ARM, DISARM, UNLOCK, RELOCK
    severity     TEXT NOT NULL DEFAULT 'info',   -- info, warning, critical
    gps_lat      REAL,
    gps_lon      REAL,
    payload_json TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_device_time
    ON events(device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_type_time
    ON events(device_id, event_type, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. GEOFENCE_ZONES — Saved geofence anchor points
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geofence_zones (
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

CREATE INDEX IF NOT EXISTS idx_geofence_device
    ON geofence_zones(device_id, is_active);

-- ---------------------------------------------------------------------------
-- 6. PAYMENT_INVOICES — KHQR payment records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_invoices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    device_id       TEXT,
    invoice_ref     TEXT NOT NULL UNIQUE,
    payway_txn_id   TEXT,
    amount_usd      REAL NOT NULL DEFAULT 15.00,
    status          TEXT NOT NULL DEFAULT 'pending',   -- pending, paid, expired, failed
    qr_code_data    TEXT,
    payway_response TEXT,
    expires_at      TEXT,
    paid_at         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_user
    ON payment_invoices(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 7. TRIPS — Reconstructed trip logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
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

CREATE INDEX IF NOT EXISTS idx_trips_device
    ON trips(device_id, start_time DESC);

-- ---------------------------------------------------------------------------
-- 8. NOTIFICATION_LOG — All Telegram push notifications sent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_log (
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

-- ---------------------------------------------------------------------------
-- 9. SCORING_LOGS — AI/heuristic predicted safety & eco scores
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scoring_logs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id      TEXT NOT NULL,
    trip_id        INTEGER,
    score_type     TEXT NOT NULL,          -- safety | eco | battery_health
    score_value    INTEGER NOT NULL,       -- 0-100
    model_version  TEXT,
    input_features TEXT,
    computed_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- 10. DEVICE_COMMANDS — Downlink queue (arm/disarm/relay pulled by device)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_commands (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    command      TEXT NOT NULL,            -- ARM, DISARM, RELAY_PULSE, OTA
    payload_json TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',   -- pending, delivered, acked, expired
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commands_device
    ON device_commands(device_id, status, created_at);
