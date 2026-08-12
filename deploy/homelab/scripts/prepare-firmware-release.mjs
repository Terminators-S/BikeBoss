import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseCanonicalPayload } from '../../../backend/src/lib/firmware-ota.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const [rawBinaryPath, version, rawBuild, deviceId = 'BB-00000001', ...notesParts]
  = process.argv.slice(2);
const buildNumber = Number(rawBuild);
const notes = notesParts.join(' ').trim() || `BikeBoss ${version} home-lab update`;

if (!rawBinaryPath
    || !/^[0-9A-Za-z.+_-]{1,32}$/u.test(version ?? '')
    || !Number.isSafeInteger(buildNumber) || buildNumber <= 0
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(deviceId)
    || notes.length > 500) {
  console.error(
    'Usage: node prepare-firmware-release.mjs <firmware.bin> <version> '
      + '<build-number> [device-id] [release notes]',
  );
  process.exit(2);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const binaryPath = resolve(rawBinaryPath);
const binary = await readFile(binaryPath);
const binaryDetails = await stat(binaryPath);
if (!binaryDetails.isFile() || binary.length === 0) {
  throw new Error('The firmware binary is missing or empty.');
}

const privateKeyPath = resolve(
  process.env.BIKEBOSS_OTA_PRIVATE_KEY
    ?? resolve(homedir(), '.bikeboss-ota', 'release-key.pem'),
);
const privateKey = createPrivateKey(await readFile(privateKeyPath));
const objectKey = `seeed_xiao_esp32s3/${buildNumber}/firmware.bin`;
const release = {
  release_uuid: randomUUID(),
  version,
  build_number: buildNumber,
  board: 'seeed_xiao_esp32s3',
  object_key: objectKey,
  size_bytes: binary.length,
  sha256_hex: createHash('sha256').update(binary).digest('hex'),
};
release.signature_b64 = sign(
  'sha256',
  Buffer.from(releaseCanonicalPayload(release)),
  privateKey,
).toString('base64url');

const stagingParent = resolve(
  process.env.BIKEBOSS_RELEASE_OUTPUT
    ?? resolve(scriptDirectory, '..', 'runtime', 'release-staging'),
);
const outputDirectory = resolve(stagingParent, String(buildNumber));
const firmwareOutput = resolve(outputDirectory, 'firmware', objectKey);
await mkdir(stagingParent, { recursive: true });
await mkdir(outputDirectory);
await mkdir(dirname(firmwareOutput), { recursive: true });
await copyFile(binaryPath, firmwareOutput, fsConstants.COPYFILE_EXCL);

const registrationSql = `BEGIN IMMEDIATE;
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
COMMIT;
`;

const manifest = {
  ...release,
  device_id: deviceId,
  notes,
  prepared_at: new Date().toISOString(),
  binary_path: `firmware/${objectKey}`,
};
await writeFile(
  resolve(outputDirectory, 'release.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 },
);
await writeFile(
  resolve(outputDirectory, 'register.sql'),
  registrationSql,
  { flag: 'wx', mode: 0o600 },
);

console.log(JSON.stringify({ output_directory: outputDirectory, ...manifest }, null, 2));
