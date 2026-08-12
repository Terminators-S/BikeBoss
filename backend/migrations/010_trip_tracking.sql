-- Automatic trip lifecycle and route ownership.
-- Historical telemetry remains unlinked; the trip detail API falls back to
-- each legacy trip's start/end window when trip_id is NULL.

ALTER TABLE telemetry ADD COLUMN trip_id INTEGER
    REFERENCES trips(id) ON DELETE SET NULL;

ALTER TABLE trips ADD COLUMN last_moving_at TEXT;
ALTER TABLE trips ADD COLUMN stationary_since TEXT;

UPDATE trips
SET last_moving_at = COALESCE(end_time, start_time)
WHERE last_moving_at IS NULL;

-- Older reconstruction could leave more than one open row. Keep the newest
-- one open so the partial unique index can enforce the invariant from now on.
UPDATE trips
SET end_time = COALESCE(last_moving_at, start_time),
    avg_speed_kmh = 0
WHERE end_time IS NULL
  AND id NOT IN (
    SELECT MAX(id) FROM trips WHERE end_time IS NULL GROUP BY device_id
  );

CREATE INDEX IF NOT EXISTS idx_telemetry_trip_time
    ON telemetry(trip_id, captured_at ASC, id ASC)
    WHERE trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_one_open_per_device
    ON trips(device_id) WHERE end_time IS NULL;
