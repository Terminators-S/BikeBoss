const RELEASE_ID_PATTERN = /^[0-9a-f-]{36}$/iu;
const VERSION_PATTERN = /^[0-9A-Za-z.+_-]{1,32}$/u;
const BOARD_PATTERN = /^[0-9a-z_]{1,64}$/u;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Build the staging registration statement for an immutable firmware release.
 *
 * Publishing inserts release metadata and a pending canary eligibility row.
 * The OTA command is created later by the authenticated Mini App install
 * endpoint, so merely publishing a binary can never start a device update.
 */
export function buildFirmwareReleaseRegistrationSql(release, deviceId, notes) {
  if (!RELEASE_ID_PATTERN.test(release?.release_uuid ?? '')
      || !VERSION_PATTERN.test(release?.version ?? '')
      || !Number.isSafeInteger(release?.build_number) || release.build_number <= 0
      || !BOARD_PATTERN.test(release?.board ?? '')
      || typeof release?.object_key !== 'string' || release.object_key.length < 1
      || !Number.isSafeInteger(release?.size_bytes) || release.size_bytes <= 0
      || !SHA256_PATTERN.test(release?.sha256_hex ?? '')
      || typeof release?.signature_b64 !== 'string' || release.signature_b64.length < 1
      || !DEVICE_ID_PATTERN.test(deviceId ?? '')) {
    throw new TypeError('Firmware release metadata is invalid.');
  }

  return `
INSERT INTO firmware_releases (
  release_uuid, version, build_number, board, object_key,
  size_bytes, sha256_hex, signature_b64, status, notes
) VALUES (
  ${sqlString(release.release_uuid)}, ${sqlString(release.version)}, ${release.build_number},
  ${sqlString(release.board)}, ${sqlString(release.object_key)}, ${release.size_bytes},
  ${sqlString(release.sha256_hex)}, ${sqlString(release.signature_b64)}, 'active',
  ${sqlString(notes)}
);
INSERT INTO firmware_rollouts (release_uuid, device_id, status)
VALUES (${sqlString(release.release_uuid)}, ${sqlString(deviceId)}, 'pending');
`;
}
