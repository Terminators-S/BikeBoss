import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compactDeviceResponse,
  normalizeCompactTelemetry,
  normalizeTelemetryBatch,
  normalizeTelemetryEnvelope,
} from '../src/lib/telemetry-codec.js';

const compactPoint = {
  v: 2,
  id: 'BB-00000001',
  q: 42,
  t: 1_800_000_000,
  a: 1,
  g: [1, 116_412_230, 1_049_197_620, 125, 83, 17, 9, 1_234, 151],
  m: [1, 1, 979, 125],
  b: 12_600,
  c: 0,
};

test('compact telemetry stays below the 256-byte routine target', () => {
  const raw = JSON.stringify(compactPoint);
  assert.ok(Buffer.byteLength(raw) <= 256, `payload is ${Buffer.byteLength(raw)} bytes`);
});

test('compact telemetry expands scaled integers into the descriptive contract', () => {
  const result = normalizeCompactTelemetry({
    ...compactPoint,
    k: [[16, 1], [17, 0]],
    o: [1, 1, 4, 920],
    u: [1, -57, 'Phone hotspot'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.device_id, 'BB-00000001');
  assert.equal(result.value.message_id, 'BB-00000001-42');
  assert.equal(result.value.captured_at, '2027-01-15T08:00:00.000Z');
  assert.equal(result.value.gps.lat, 11.641223);
  assert.equal(result.value.gps.lon, 104.919762);
  assert.equal(result.value.gps.speed_m_s, 1.25);
  assert.equal(result.value.gps.speed, 4.5);
  assert.equal(result.value.gps.accuracy_m, 8.3);
  assert.equal(result.value.gps.hdop, 1.7);
  assert.equal(result.value.gps.heading, 123.4);
  assert.equal(result.value.gps.altitude_m, 15.1);
  assert.equal(result.value.imu.atotal, 9.79);
  assert.equal(result.value.imu.gtotal, 0.125);
  assert.equal(result.value.vbat, 12.6);
  assert.deepEqual(result.value.command_acks, [
    { id: 16, status: 'applied' },
    { id: 17, status: 'failed' },
  ]);
  assert.deepEqual(result.value.owner_presence, {
    authenticated: true,
    connected: true,
    age_seconds: 4,
    confidence: 0.92,
  });
  assert.deepEqual(result.value.uplink, {
    type: 'wifi',
    signal_dbm: -57,
    generation: null,
    label: 'Phone hotspot',
  });
});

test('compact telemetry accepts an opaque trusted Wi-Fi profile id', () => {
  const result = normalizeCompactTelemetry({
    ...compactPoint,
    u: [1, -61, null, '6a945012-0765-42e6-9e06-b20bbbf59280'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.uplink.profile_id, '6a945012-0765-42e6-9e06-b20bbbf59280');
  assert.equal(result.value.uplink.label, null);
});

test('compact no-fix packets omit coordinates without inventing precision', () => {
  const result = normalizeTelemetryEnvelope({ ...compactPoint, g: [0] });
  assert.equal(result.ok, true);
  assert.equal(result.value.gps.fix, false);
  assert.equal(result.value.gps.lat, null);
  assert.equal(result.value.gps.accuracy_m, null);
});

test('compact telemetry accepts an unavailable bench battery measurement', () => {
  const packet = { ...compactPoint };
  delete packet.b;

  const result = normalizeCompactTelemetry(packet);
  assert.equal(result.ok, true);
  assert.equal(result.value.vbat, null);
});

test('compact telemetry rejects invalid ranges and unsupported versions', () => {
  assert.equal(normalizeCompactTelemetry({ ...compactPoint, v: 3 }).error, 'telemetry_version_unsupported');
  assert.equal(
    normalizeCompactTelemetry({ ...compactPoint, g: [1, 999_000_000, 0, 0, 0, 0, 0, 0, 0] }).error,
    'gps_invalid',
  );
  assert.equal(normalizeCompactTelemetry({ ...compactPoint, k: [[1, 2]] }).error, 'command_acks_invalid');
  assert.equal(normalizeCompactTelemetry({ ...compactPoint, o: [1, 0, 0, 900] }).error, 'owner_presence_invalid');
  assert.equal(normalizeCompactTelemetry({ ...compactPoint, u: [3, -50] }).error, 'uplink_invalid');
  assert.equal(normalizeCompactTelemetry({ ...compactPoint, u: [1, -50, 'x'.repeat(33)] }).error, 'uplink_invalid');
});

test('ordinary BLE connectivity is never promoted to authenticated owner presence', () => {
  const result = normalizeCompactTelemetry({ ...compactPoint, o: [0, 1, 2, 0] });
  assert.equal(result.ok, true);
  assert.equal(result.value.owner_presence.connected, true);
  assert.equal(result.value.owner_presence.authenticated, false);
  assert.equal(result.value.owner_presence.confidence, 0);
});

test('offline batch requires strictly increasing points ending at request sequence', () => {
  const first = { ...compactPoint, q: 41 };
  delete first.id;
  delete first.v;
  const second = { ...compactPoint };
  delete second.id;
  delete second.v;

  const valid = normalizeTelemetryBatch({
    v: 2,
    id: compactPoint.id,
    q: 42,
    p: [first, second],
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.samples.map((sample) => sample.sequence), [41, 42]);

  assert.equal(normalizeTelemetryBatch({
    v: 2,
    id: compactPoint.id,
    q: 42,
    p: [second, first],
  }).error, 'telemetry_batch_sequence_invalid');
  assert.equal(normalizeTelemetryBatch({
    v: 2,
    id: compactPoint.id,
    q: 43,
    p: [first, second],
  }).error, 'sequence_mismatch');
});

test('empty compact command response remains below the 96-byte target', () => {
  const empty = JSON.stringify(compactDeviceResponse(42));
  assert.ok(Buffer.byteLength(empty) <= 96, `response is ${Buffer.byteLength(empty)} bytes`);
  assert.deepEqual(JSON.parse(empty), { ok: 1, q: 42, c: [] });

  assert.deepEqual(compactDeviceResponse(42, [{
    id: 16,
    command: 'DISARM',
    payload_json: null,
  }]), { ok: 1, q: 42, c: [[16, 'DISARM']] });
});
