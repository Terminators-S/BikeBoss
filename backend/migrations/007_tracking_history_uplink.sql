-- Reliable Tracking Everywhere foundation.
-- Uplink metadata is deliberately privacy-safe: no SSID, phone name, carrier
-- account, IP address, or other network identifier is persisted.

ALTER TABLE telemetry ADD COLUMN uplink_type TEXT;
ALTER TABLE telemetry ADD COLUMN uplink_signal_dbm INTEGER;
ALTER TABLE telemetry ADD COLUMN uplink_generation TEXT;

-- Historical route reads use captured_at for signed/offline-replayed samples.
-- The existing device+received_at index remains the fallback for legacy rows.
CREATE INDEX IF NOT EXISTS idx_telemetry_device_fix_captured
    ON telemetry(device_id, captured_at DESC)
    WHERE gps_fix = 1 AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL;
