import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFirmwareReleaseRegistrationSql } from '../src/lib/firmware-release.js';

const release = {
  release_uuid: '11111111-2222-4333-8444-555555555555',
  version: '0.1.4',
  build_number: 2026081206,
  board: 'seeed_xiao_esp32s3',
  object_key: 'seeed_xiao_esp32s3/2026081206/firmware.bin',
  size_bytes: 1601808,
  sha256_hex: 'a'.repeat(64),
  signature_b64: 'MEUCIQfixture',
};

test('publishing registers a release without queuing a device update', () => {
  const sql = buildFirmwareReleaseRegistrationSql(
    release,
    'BB-00000001',
    "Manual rider approval test's release",
  );

  assert.match(sql, /INSERT INTO firmware_releases/u);
  assert.match(sql, /INSERT INTO firmware_rollouts/u);
  assert.match(sql, /BB-00000001/u);
  assert.match(sql, /Manual rider approval test''s release/u);
  assert.doesNotMatch(sql, /device_commands/u);
  assert.doesNotMatch(sql, /\bOTA\b/u);
});

test('publishing rejects malformed immutable release metadata', () => {
  assert.throws(
    () => buildFirmwareReleaseRegistrationSql(
      { ...release, sha256_hex: 'bad' },
      'BB-00000001',
      'notes',
    ),
    /metadata is invalid/u,
  );
});
