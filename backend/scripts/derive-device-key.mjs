/**
 * Derive the same per-device key used by the Worker without exposing the
 * master in a command-line argument or source file.
 *
 * Required environment variable: BIKEBOSS_DEVICE_KEY_MASTER
 * Usage: npm run device:key -- BB-00000001 [key-version]
 */

import { createHmac } from 'node:crypto';

const deviceId = String(process.argv[2] ?? '').toUpperCase().trim();
const keyVersion = Number(process.argv[3] ?? 1);
const master = process.env.BIKEBOSS_DEVICE_KEY_MASTER;

if (!/^BB-[A-Z0-9-]{4,}$/u.test(deviceId)) {
  console.error('Usage: npm run device:key -- BB-00000001 [key-version]');
  process.exitCode = 2;
} else if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
  console.error('Key version must be a positive integer.');
  process.exitCode = 2;
} else if (!master || master.length < 32) {
  console.error('Set BIKEBOSS_DEVICE_KEY_MASTER to the same 32+ character Worker secret.');
  process.exitCode = 2;
} else {
  const key = createHmac('sha256', master)
    .update(`${deviceId}:v${keyVersion}`, 'utf8')
    .digest('hex');
  console.log(`Device: ${deviceId}`);
  console.log(`Key version: ${keyVersion}`);
  console.log(`DEVICE_SIGNING_KEY_HEX=${key}`);
  console.log('Treat this per-device key as a secret and provision it only to that device.');
}
