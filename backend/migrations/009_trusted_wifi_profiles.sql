-- Encrypted, revisioned multi-Wi-Fi configuration for dedicated trackers.
-- credential_ciphertext contains a device-specific AES-GCM envelope. Passwords
-- and raw SSIDs must never be written to logs, telemetry, or command payloads.

ALTER TABLE devices ADD COLUMN wifi_config_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN wifi_config_applied_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE telemetry ADD COLUMN uplink_profile_id TEXT;

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

CREATE INDEX IF NOT EXISTS idx_telemetry_uplink_profile
    ON telemetry(device_id, uplink_profile_id, captured_at DESC)
    WHERE uplink_profile_id IS NOT NULL;
