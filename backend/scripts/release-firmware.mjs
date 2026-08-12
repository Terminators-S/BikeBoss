import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseCanonicalPayload } from '../src/lib/firmware-ota.js';
import { buildFirmwareReleaseRegistrationSql } from '../src/lib/firmware-release.js';

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
const backendDirectory = resolve(scriptDirectory, '..');
const firmwareDirectory = resolve(backendDirectory, '..', 'firmware');
const [version, rawBuild, deviceId = 'BB-00000001', environment = 'staging', ...notesParts]
  = process.argv.slice(2);
const buildNumber = Number(rawBuild);
const notes = notesParts.join(' ').trim() || `BikeBoss ${version} staging update`;

if (!/^[0-9A-Za-z.+_-]{1,32}$/u.test(version ?? '')
    || !Number.isSafeInteger(buildNumber) || buildNumber <= 0
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(deviceId)
    || environment !== 'staging'
    || notes.length > 500) {
  console.error(
    'Usage: npm run firmware:release -- <version> <build-number> [device-id] staging [release notes]',
  );
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
    ORDER BY build_number DESC
    LIMIT 1`,
]);
const latestReleaseResult = Array.isArray(releaseQuery)
  ? releaseQuery.find((entry) => Array.isArray(entry?.results))
  : releaseQuery;
const latestRelease = latestReleaseResult?.results?.[0];
if (latestRelease && buildNumber <= Number(latestRelease.build_number)) {
  throw new Error(
    `Build ${buildNumber} is not newer than published build ${latestRelease.build_number} `
      + `(${latestRelease.release_uuid}); use a higher monotonic build number.`,
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

const sql = buildFirmwareReleaseRegistrationSql(release, deviceId, notes);

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
  activation: 'manual_mini_app_install_required',
}, null, 2));
