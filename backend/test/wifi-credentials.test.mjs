import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decryptWifiProfile,
  encryptWifiProfile,
  validateWifiProfileInput,
} from '../src/lib/wifi-credentials.js';

const envelope = {
  masterSecret: 'staging-master-secret-with-more-than-32-bytes',
  deviceId: 'BB-00000001',
  profileId: '6a945012-0765-42e6-9e06-b20bbbf59280',
  version: 3,
  keyVersion: 1,
};

test('Wi-Fi credentials round-trip through a device-specific AES-GCM envelope', async () => {
  const profile = {
    label: 'Farm café',
    ssid: 'FARM KAFE',
    password: 'not-a-real-password',
    priority: 70,
  };
  const encrypted = await encryptWifiProfile({ ...envelope, profile });
  assert.ok(encrypted.nonce.length >= 16);
  assert.equal(encrypted.ciphertext.includes(profile.ssid), false);
  assert.equal(encrypted.ciphertext.includes(profile.password), false);
  assert.deepEqual(await decryptWifiProfile({ ...envelope, ...encrypted }), profile);
});

test('Wi-Fi credential envelopes are bound to device, profile and version', async () => {
  const profile = { label: 'School', ssid: 'SCHOOL-WIFI', password: '', priority: 50 };
  const encrypted = await encryptWifiProfile({ ...envelope, profile });
  await assert.rejects(decryptWifiProfile({
    ...envelope,
    deviceId: 'BB-OTHER0001',
    ...encrypted,
  }));
  await assert.rejects(decryptWifiProfile({
    ...envelope,
    version: envelope.version + 1,
    ...encrypted,
  }));
});

test('Wi-Fi input validation preserves exact SSIDs and rejects unsafe passwords', () => {
  const valid = validateWifiProfileInput({
    label: '  Farm café  ',
    ssid: 'FARM KAFE',
    password: '12345678',
    priority: 80,
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.label, 'Farm café');
  assert.equal(valid.value.ssid, 'FARM KAFE');
  assert.equal(validateWifiProfileInput({
    label: 'Bad', ssid: 'x', password: 'short', priority: 50,
  }).error, 'wifi_password_invalid');
});
