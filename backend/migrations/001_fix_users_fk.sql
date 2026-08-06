-- Migration 001: repair FK references left pointing at users_old
-- after the users table was rebuilt for nullable language.
-- Run with: npx wrangler d1 execute bikeboss-db --remote --file=./migrations/001_fix_users_fk.sql

PRAGMA foreign_keys = OFF;

-- devices
CREATE TABLE devices_new (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id           TEXT NOT NULL UNIQUE,
    owner_id            INTEGER,
    vehicle_plate       TEXT,
    vehicle_model       TEXT,
    vehicle_year        INTEGER,
    install_mode        TEXT NOT NULL DEFAULT 'universal',
    data_sim_iccid      TEXT,
    data_sim_expiry     TEXT,
    subscription_expiry TEXT,
    firmware_ver        TEXT NOT NULL DEFAULT '1.0.0',
    is_active           INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO devices_new SELECT * FROM devices;
DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;
CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner_id);

PRAGMA foreign_keys = ON;
