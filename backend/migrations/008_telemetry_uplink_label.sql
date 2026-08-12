-- Optional, privacy-safe connection profile name shown to the owner.
-- This is a friendly alias such as "Phone hotspot", never the raw SSID,
-- password, IP address, SIM identifier, or account information.

ALTER TABLE telemetry ADD COLUMN uplink_label TEXT;
