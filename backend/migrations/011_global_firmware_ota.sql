-- Private, signed firmware releases and explicit per-device canary rollouts.

ALTER TABLE devices ADD COLUMN firmware_build INTEGER NOT NULL DEFAULT 0;

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
