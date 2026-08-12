import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  connectivityFromTelemetry,
  measuredVehicleBattery,
  parseDatabaseTimestamp,
} from '../src/lib/device-status.js';

test('database timestamps without a suffix are interpreted as UTC', () => {
  assert.equal(
    parseDatabaseTimestamp('2026-08-09 04:00:00'),
    Date.parse('2026-08-09T04:00:00Z'),
  );
});

test('connectivity uses heartbeat age rather than the existence of stale telemetry', () => {
  const now = Date.parse('2026-08-09T04:20:00Z');
  assert.equal(
    connectivityFromTelemetry({ received_at: '2026-08-09 04:15:01' }, 300_000, now).status,
    'online',
  );
  assert.equal(
    connectivityFromTelemetry({ received_at: '2026-08-09 04:14:59' }, 300_000, now).status,
    'offline',
  );
  assert.equal(connectivityFromTelemetry(null, 300_000, now).status, 'unknown');
});

test('connectivity exposes privacy-safe uplink diagnostics from the latest heartbeat', () => {
  const now = Date.parse('2026-08-09T04:20:00Z');
  const result = connectivityFromTelemetry({
    received_at: '2026-08-09 04:19:58',
    uplink_type: 'wifi',
    uplink_signal_dbm: -61,
    uplink_generation: null,
    uplink_label: 'Phone hotspot',
  }, 300_000, now);
  assert.equal(result.transport, 'wifi');
  assert.equal(result.signal_dbm, -61);
  assert.equal(result.generation, null);
  assert.equal(result.label, 'Phone hotspot');
});

test('connectivity uses the newest receipt while location is ordered by capture time', () => {
  const now = Date.parse('2026-08-09T04:20:00Z');
  const result = connectivityFromTelemetry({
    received_at: '2026-08-09 04:00:00',
    last_received_at: '2026-08-09 04:19:58',
  }, 300_000, now);
  assert.equal(result.status, 'online');
  assert.equal(result.last_seen_at, '2026-08-09 04:19:58');
});

test('vehicle battery is unknown when the firmware did not measure it', () => {
  assert.equal(measuredVehicleBattery({ vbat: null }), null);
  assert.equal(measuredVehicleBattery({}), null);
  assert.equal(measuredVehicleBattery({ vbat: 0 }), null);
  assert.equal(measuredVehicleBattery({ vbat: 12.45 }), 12.45);
});
