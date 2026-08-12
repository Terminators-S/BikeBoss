-- Staging-only: connect the five registration fixtures to the physical bench
-- prototype's live telemetry without granting shared hardware control.
-- Do not apply this migration to production.

ALTER TABLE devices ADD COLUMN telemetry_source_device_id TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_telemetry_source
    ON devices(telemetry_source_device_id);

UPDATE devices
SET telemetry_source_device_id = 'BB-00000001',
    updated_at = datetime('now')
WHERE device_id IN (
    'BB-TEST0001',
    'BB-TEST0002',
    'BB-TEST0003',
    'BB-TEST0004',
    'BB-TEST0005'
);
