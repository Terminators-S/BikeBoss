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
    language        TEXT,                          -- NULL until user picks on /start (en | km)
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
    firmware_build      INTEGER NOT NULL DEFAULT 0,
    is_active           INTEGER NOT NULL DEFAULT 1,
    telemetry_source_device_id TEXT,                   -- staging aliases may mirror a prototype
    wifi_config_revision INTEGER NOT NULL DEFAULT 0,
    wifi_config_applied_revision INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner_id);
CREATE INDEX IF NOT EXISTS idx_devices_telemetry_source ON devices(telemetry_source_device_id);

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
    message_id          TEXT,
    sequence            INTEGER,
    captured_at         TEXT,
    gps_accuracy_m      REAL,
    gps_hdop            REAL,
    gps_satellites      INTEGER,
    gps_heading         REAL,
    gps_altitude_m      REAL,
    gps_source          TEXT,
    motion_state        TEXT,
    ignition_state      INTEGER,
    owner_presence_connected INTEGER,
    owner_presence_authenticated INTEGER,
    owner_presence_age_s INTEGER,
    owner_presence_confidence REAL,
    uplink_type         TEXT,                          -- wifi, cellular, ethernet, unknown
    uplink_signal_dbm   INTEGER,                       -- privacy-safe link signal; never store SSID
    uplink_generation   TEXT,                          -- e.g. 4g; NULL for Wi-Fi
    uplink_label        TEXT,                          -- friendly profile alias; never raw SSID/account data
    uplink_profile_id   TEXT,                          -- opaque trusted profile UUID; never raw SSID
    trip_id             INTEGER,
    received_at         TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_device_time
    ON telemetry(device_id, received_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_message_id
    ON telemetry(message_id) WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telemetry_device_captured
    ON telemetry(device_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_device_fix_captured
    ON telemetry(device_id, captured_at DESC)
    WHERE gps_fix = 1 AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telemetry_uplink_profile
    ON telemetry(device_id, uplink_profile_id, captured_at DESC)
    WHERE uplink_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telemetry_trip_time
    ON telemetry(trip_id, captured_at ASC, id ASC)
    WHERE trip_id IS NOT NULL;

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
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id            TEXT NOT NULL,
    label                TEXT NOT NULL,
    anchor_lat           REAL NOT NULL,
    anchor_lon           REAL NOT NULL,
    radius_m             REAL NOT NULL DEFAULT 100.0,
    is_active            INTEGER NOT NULL DEFAULT 1,
    zone_uuid            TEXT UNIQUE,
    zone_type            TEXT NOT NULL DEFAULT 'circle',
    policy_type          TEXT NOT NULL DEFAULT 'safe',
    status               TEXT NOT NULL DEFAULT 'active',
    version              INTEGER NOT NULL DEFAULT 1,
    exit_buffer_m        REAL NOT NULL DEFAULT 10.0,
    entry_buffer_m       REAL NOT NULL DEFAULT 5.0,
    confirm_samples      INTEGER NOT NULL DEFAULT 2,
    confirm_seconds      INTEGER NOT NULL DEFAULT 0,
    gps_accuracy_limit_m REAL NOT NULL DEFAULT 50.0,
    schedule_json        TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_geofence_device
    ON geofence_zones(device_id, is_active);

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

CREATE TABLE IF NOT EXISTS device_zone_state (
    device_id           TEXT NOT NULL,
    zone_id             INTEGER NOT NULL,
    zone_version        INTEGER NOT NULL,
    state               TEXT NOT NULL DEFAULT 'UNKNOWN',
    candidate_count     INTEGER NOT NULL DEFAULT 0,
    candidate_since     TEXT,
    lifecycle_id        TEXT,
    last_distance_m     REAL,
    last_accuracy_m     REAL,
    last_classification TEXT,
    last_sample_at      TEXT,
    last_transition_at  TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
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
    alert_suppressed   INTEGER NOT NULL DEFAULT 0,
    suppression_reason TEXT,
    owner_presence_json TEXT,
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
    last_moving_at TEXT,
    stationary_since TEXT,
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trips_device
    ON trips(device_id, start_time DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_one_open_per_device
    ON trips(device_id) WHERE end_time IS NULL;

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
    acknowledged_at TEXT,
    ack_status       TEXT,
    ack_payload_json TEXT,
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commands_device
    ON device_commands(device_id, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_active_ota_release
    ON device_commands(device_id, json_extract(payload_json, '$.release_id'))
    WHERE command = 'OTA' AND status IN ('pending', 'delivered');

-- ---------------------------------------------------------------------------
-- 11. FIRMWARE RELEASES / ROLLOUTS — private signed global OTA
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS firmware_releases (
    release_uuid  TEXT PRIMARY KEY,
    version       TEXT NOT NULL,
    build_number  INTEGER NOT NULL UNIQUE,
    board         TEXT NOT NULL,
    object_key    TEXT NOT NULL UNIQUE,
    size_bytes    INTEGER NOT NULL,
    sha256_hex    TEXT NOT NULL,
    signature_b64 TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (build_number > 0),
    CHECK (size_bytes > 0 AND size_bytes <= 3342336),
    CHECK (length(sha256_hex) = 64),
    CHECK (status IN ('draft', 'active', 'revoked'))
);

CREATE TABLE IF NOT EXISTS firmware_rollouts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    release_uuid      TEXT NOT NULL,
    device_id         TEXT NOT NULL,
    command_id        INTEGER,
    status            TEXT NOT NULL DEFAULT 'pending',
    offered_at        TEXT,
    installed_at      TEXT,
    failed_at         TEXT,
    failure_reason    TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (release_uuid) REFERENCES firmware_releases(release_uuid) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
    FOREIGN KEY (command_id) REFERENCES device_commands(id) ON DELETE SET NULL,
    UNIQUE (release_uuid, device_id),
    CHECK (status IN ('pending', 'offered', 'installed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_firmware_rollouts_device_status
    ON firmware_rollouts(device_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 11. TRUSTED WI-FI PROFILES — encrypted per-device configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wifi_profiles (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_uuid          TEXT NOT NULL UNIQUE,
    device_id             TEXT NOT NULL,
    label                 TEXT NOT NULL,
    credential_ciphertext TEXT NOT NULL,
    credential_nonce      TEXT NOT NULL,
    key_version           INTEGER NOT NULL DEFAULT 1,
    priority              INTEGER NOT NULL DEFAULT 50,
    status                TEXT NOT NULL DEFAULT 'active',
    version               INTEGER NOT NULL DEFAULT 1,
    last_connected_at     TEXT,
    last_failed_at        TEXT,
    success_count         INTEGER NOT NULL DEFAULT 0,
    failure_count         INTEGER NOT NULL DEFAULT 0,
    learned_lat           REAL,
    learned_lon           REAL,
    learned_radius_m      REAL,
    observation_count     INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
    CHECK (priority BETWEEN 1 AND 100),
    CHECK (status IN ('active', 'disabled', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_wifi_profiles_device_status
    ON wifi_profiles(device_id, status, priority DESC);

-- ---------------------------------------------------------------------------
-- 11. AUDIT_LOG — security-sensitive user and device changes
-- ---------------------------------------------------------------------------
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
