-- Prevent duplicate active OTA commands when a rider retries an install request.

CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_active_ota_release
    ON device_commands(device_id, json_extract(payload_json, '$.release_id'))
    WHERE command = 'OTA' AND status IN ('pending', 'delivered');
