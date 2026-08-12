-- Staging-only registration fixtures.
-- These devices are claimable through the secure v2 registration flow, but
-- their pending credentials cannot authenticate signed hardware telemetry.
-- Do not apply this seed to production.

INSERT OR IGNORE INTO devices (
    device_id, owner_id, vehicle_model, firmware_ver, is_active
) VALUES
    ('BB-TEST0001', NULL, 'BikeBoss Test Unit', 'test-1.0', 1),
    ('BB-TEST0002', NULL, 'BikeBoss Test Unit', 'test-1.0', 1),
    ('BB-TEST0003', NULL, 'BikeBoss Test Unit', 'test-1.0', 1),
    ('BB-TEST0004', NULL, 'BikeBoss Test Unit', 'test-1.0', 1),
    ('BB-TEST0005', NULL, 'BikeBoss Test Unit', 'test-1.0', 1);

INSERT OR IGNORE INTO device_credentials (
    device_id, key_version, status
) VALUES
    ('BB-TEST0001', 1, 'pending'),
    ('BB-TEST0002', 1, 'pending'),
    ('BB-TEST0003', 1, 'pending'),
    ('BB-TEST0004', 1, 'pending'),
    ('BB-TEST0005', 1, 'pending');
