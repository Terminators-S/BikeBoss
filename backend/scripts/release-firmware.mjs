import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseCanonicalPayload } from '../src/lib/firmware-ota.js';

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
const backendDirectory = resolve(scriptDirectory, '..');
const firmwareDirectory = resolve(backendDirectory, '..', 'firmware');
const [version, rawBuild, deviceId = 'BB-00000001', environment = 'staging'] = process.argv.slice(2);
const buildNumber = Number(rawBuild);

if (!/^[0-9A-Za-z.+_-]{1,32}$/u.test(version ?? '')
    || !Number.isSafeInteger(buildNumber) || buildNumber <= 0
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(deviceId)
    || environment !== 'staging') {
  console.error('Usage: npm run firmware:release -- <version> <build-number> [device-id] staging');
  process.exit(2);
}

const privateKeyPath = process.env.BIKEBOSS_OTA_PRIVATE_KEY
  ?? resolve(homedir(), '.bikeboss-ota', 'release-key.pem');
const privateKey = createPrivateKey(readFileSync(privateKeyPath));
const buildEnvironment = 'seeed_xiao_esp32s3_staging_signed_release';
const commandEnvironment = {
  ...process.env,
  BIKEBOSS_FIRMWARE_VERSION: version,
  BIKEBOSS_FIRMWARE_BUILD: String(buildNumber),
};
const wranglerCli = resolve(backendDirectory, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
function runWrangler(args, options) {
  return execFileSync(process.execPath, [wranglerCli, ...args], options);
}
function runWranglerJson(args) {
  const output = runWrangler([...args, '--json'], {
    cwd: backendDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Wrangler returned invalid JSON: ${error.message}`);
  }
}

const objectKey = `seeed_xiao_esp32s3/${buildNumber}/firmware.bin`;
const releaseQuery = runWranglerJson([
  'd1', 'execute', 'bikeboss-db-staging',
  '--env', environment, '--remote',
  '--command', `SELECT release_uuid, build_number, object_key, status
    FROM firmware_releases
    WHERE build_number = ${buildNumber}
       OR object_key = '${objectKey}'
    LIMIT 1`,
]);
const existingRelease = Array.isArray(releaseQuery)
  ? releaseQuery.find((entry) => Array.isArray(entry?.results))
  : releaseQuery;
if (existingRelease?.results?.length) {
  const prior = existingRelease.results[0];
  throw new Error(
    `Build ${buildNumber} is already published (${prior.release_uuid}); `
      + 'use a new monotonic build number.',
  );
}

execFileSync('pio', ['run', '-e', buildEnvironment], {
  cwd: firmwareDirectory,
  env: commandEnvironment,
  stdio: 'inherit',
});

const binaryPath = resolve(
  firmwareDirectory,
  '.pio',
  'build',
  buildEnvironment,
  'firmware.bin',
);
const binary = readFileSync(binaryPath);
const sizeBytes = statSync(binaryPath).size;
const sha256Hex = createHash('sha256').update(binary).digest('hex');
const release = {
  release_uuid: randomUUID(),
  version,
  build_number: buildNumber,
  board: 'seeed_xiao_esp32s3',
  object_key: objectKey,
  size_bytes: sizeBytes,
  sha256_hex: sha256Hex,
};
release.signature_b64 = sign(
  'sha256',
  Buffer.from(releaseCanonicalPayload(release)),
  privateKey,
).toString('base64url');

const bucketName = 'bikeboss-firmware-staging';
runWrangler([
  'r2', 'object', 'put', `${bucketName}/${release.object_key}`,
  '--remote',
  '--file', binaryPath,
  '--content-type', 'application/octet-stream',
], { cwd: backendDirectory, stdio: 'inherit' });

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const sql = `
INSERT INTO firmware_releases (
  release_uuid, version, build_number, board, object_key,
  size_bytes, sha256_hex, signature_b64, status, notes
) VALUES (
  ${sqlString(release.release_uuid)}, ${sqlString(version)}, ${buildNumber},
  ${sqlString(release.board)}, ${sqlString(release.object_key)}, ${sizeBytes},
  ${sqlString(sha256Hex)}, ${sqlString(release.signature_b64)}, 'active',
  ${sqlString(`Canary release for ${deviceId}`)}
);
INSERT INTO firmware_rollouts (release_uuid, device_id)
VALUES (${sqlString(release.release_uuid)}, ${sqlString(deviceId)});
INSERT INTO device_commands (device_id, command, payload_json)
VALUES (
  ${sqlString(deviceId)}, 'OTA',
  ${sqlString(JSON.stringify({ release_id: release.release_uuid }))}
);
`;

runWrangler([
  'd1', 'execute', 'bikeboss-db-staging',
  '--env', environment, '--remote', '--command', sql,
], { cwd: backendDirectory, stdio: 'inherit' });

console.log(JSON.stringify({
  release_id: release.release_uuid,
  version,
  build_number: buildNumber,
  device_id: deviceId,
  size_bytes: sizeBytes,
  sha256: sha256Hex,
  environment,
}, null, 2));
