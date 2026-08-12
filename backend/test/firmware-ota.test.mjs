import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactFirmwareManifest,
  deriveFirmwareUpdateState,
  handleFirmwareDownloadV2,
  normalizeFirmwareDownloadPreference,
  releaseCanonicalPayload,
  summarizeFirmwareRelease,
} from '../src/lib/firmware-ota.js';
import { signDeviceRequest } from '../src/lib/auth.js';

const release = {
  release_uuid: '11111111-2222-4333-8444-555555555555',
  version: '0.2.0',
  build_number: 2026081201,
  board: 'seeed_xiao_esp32s3',
  object_key: 'seeed_xiao_esp32s3/2026081201/firmware.bin',
  size_bytes: 4,
  sha256_hex: 'a'.repeat(64),
  signature_b64: 'MEUCIQfixture',
  status: 'active',
};

test('firmware release canonical payload and compact manifest are stable', () => {
  assert.equal(
    releaseCanonicalPayload(release),
    [
      'bikeboss-ota-v1', release.release_uuid, release.version,
      release.build_number, release.board, release.size_bytes, release.sha256_hex,
    ].join('\n'),
  );
  assert.deepEqual(compactFirmwareManifest(release, 'BB-00000001'), {
    r: release.release_uuid,
    v: release.version,
    n: release.build_number,
    b: release.board,
    z: release.size_bytes,
    h: release.sha256_hex,
    s: release.signature_b64,
    p: `/api/v2/device/BB-00000001/firmware/${release.release_uuid}`,
    t: 'wifi',
  });
  assert.equal(
    compactFirmwareManifest(release, 'BB-00000001', 'any_internet').t,
    'any',
  );
  assert.equal(normalizeFirmwareDownloadPreference('unexpected'), 'wifi_only');
});

test('firmware update state is safe, monotonic and retryable', () => {
  assert.equal(deriveFirmwareUpdateState({
    currentBuild: release.build_number - 1,
    release,
    credentialActive: true,
  }), 'available');
  assert.equal(deriveFirmwareUpdateState({
    currentBuild: release.build_number - 1,
    release,
    credentialActive: true,
    command: { status: 'pending' },
  }), 'queued');
  assert.equal(deriveFirmwareUpdateState({
    currentBuild: release.build_number - 1,
    release,
    credentialActive: true,
    rollout: { status: 'offered' },
    command: { status: 'delivered' },
  }), 'preparing');
  assert.equal(deriveFirmwareUpdateState({
    currentBuild: release.build_number,
    release,
  }), 'up_to_date');
  assert.equal(deriveFirmwareUpdateState({
    currentBuild: 0,
    release,
    credentialActive: true,
  }), 'usb_required');
  assert.equal(deriveFirmwareUpdateState({
    currentBuild: release.build_number - 1,
    release,
    credentialActive: true,
    rollout: { status: 'failed' },
  }), 'failed');
});

test('firmware release summary exposes update metadata but not storage or signatures', () => {
  const summary = summarizeFirmwareRelease({
    ...release,
    notes: 'GPS replay hardening',
    created_at: '2026-08-12 05:00:00',
  });
  assert.equal(summary.version, release.version);
  assert.equal(summary.build_number, release.build_number);
  assert.equal(summary.notes, 'GPS replay hardening');
  assert.equal('object_key' in summary, false);
  assert.equal('signature_b64' in summary, false);
  assert.equal('sha256_hex' in summary, false);
});

test('firmware download requires a signed eligible device request and streams R2', async () => {
  const nowMs = Date.now();
  const deviceId = 'BB-00000001';
  const pathname = `/api/v2/device/${deviceId}/firmware/${release.release_uuid}`;
  const input = {
    method: 'GET', pathname, deviceId,
    timestamp: Math.floor(nowMs / 1000), sequence: 9, keyVersion: 1, rawBody: '',
  };
  const signature = await signDeviceRequest(input, 'master-secret');
  const request = new Request(`https://api.example${pathname}`, {
    headers: { 'X-BikeBoss-Auth': `${input.timestamp}.9.1.${signature}` },
  });
  const statements = [];
  const env = {
    DEVICE_KEY_MASTER: 'master-secret',
    DEVICE_REQUEST_MAX_SKEW_SECONDS: 300,
    DB: {
      prepare(sql) {
        statements.push(sql);
        return {
          bind: (...args) => ({
            first: async () => sql.includes('device_credentials')
              ? { status: 'active', last_sequence: 9 }
              : { ...release, release_uuid: args[0] },
          }),
        };
      },
    },
    FIRMWARE: {
      get: async () => ({
        size: 4,
        body: new Blob(['test']).stream(),
        writeHttpMetadata(headers) { headers.set('Content-Type', 'application/octet-stream'); },
      }),
    },
  };

  const response = await handleFirmwareDownloadV2(
    request, deviceId, release.release_uuid, env,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'test');
  assert.equal(response.headers.get('X-BikeBoss-Release'), release.release_uuid);
  assert.ok(statements.some((sql) => sql.includes('firmware_rollouts')));
});
