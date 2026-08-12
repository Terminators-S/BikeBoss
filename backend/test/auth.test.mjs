import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeviceCanonicalRequest,
  createSessionToken,
  deriveDeviceSigningKey,
  sha256Hex,
  signDeviceRequest,
  validateTelegramInitData,
  verifyDeviceRequestSignature,
  verifySessionToken,
} from '../src/lib/auth.js';

const encoder = new TextEncoder();

async function hmac(keyBytes, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    typeof keyBytes === 'string' ? encoder.encode(keyBytes) : keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

test('Telegram initData: valid HMAC produces a trusted user', async () => {
  const botToken = '123456:test-token';
  const nowMs = 1_800_000_000_000;
  const authDate = Math.floor(nowMs / 1000) - 30;
  const user = JSON.stringify({ id: 99887766, first_name: 'Sokha', username: 'sokha' });
  const fields = [`auth_date=${authDate}`, 'query_id=test-query', `user=${user}`].sort();
  const dataCheck = fields.join('\n');
  const secretKey = await hmac('WebAppData', botToken);
  const hash = hex(await hmac(secretKey, dataCheck));
  const initData = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'test-query',
    user,
    hash,
  }).toString();

  const result = await validateTelegramInitData(initData, botToken, { nowMs });
  assert.equal(result.ok, true);
  assert.equal(result.user.id, '99887766');
  assert.equal(result.user.firstName, 'Sokha');
});

test('Telegram initData: tampering and expired data are rejected', async () => {
  const initData = new URLSearchParams({
    auth_date: '1700000000',
    user: JSON.stringify({ id: 1, first_name: 'Tampered' }),
    hash: '0'.repeat(64),
  }).toString();
  const expired = await validateTelegramInitData(initData, 'token', {
    nowMs: 1_800_000_000_000,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.error, 'telegram_auth_expired');
});

test('session token: verifies, expires, and rejects payload tampering', async () => {
  const nowMs = 1_800_000_000_000;
  const token = await createSessionToken(
    { userId: 42, telegramId: '99887766' },
    'session-secret',
    { nowMs, ttlSeconds: 60 },
  );
  const actor = await verifySessionToken(token, 'session-secret', { nowMs: nowMs + 30_000 });
  assert.equal(actor.userId, 42);
  assert.equal(actor.telegramId, '99887766');

  assert.equal(
    await verifySessionToken(token, 'session-secret', { nowMs: nowMs + 61_000 }),
    null,
  );
  assert.equal(await verifySessionToken(`A${token.slice(1)}`, 'session-secret', { nowMs }), null);
});

test('device signature: canonical request is stable and body-sensitive', async () => {
  const input = {
    method: 'POST',
    pathname: '/api/v2/device/telemetry',
    deviceId: 'BB-00000001',
    timestamp: 1_800_000_000,
    sequence: 7,
    keyVersion: 1,
    rawBody: '{"device_id":"BB-00000001"}',
  };
  const first = await signDeviceRequest(input, 'master-secret');
  const second = await signDeviceRequest(input, 'master-secret');
  const changed = await signDeviceRequest({ ...input, rawBody: `${input.rawBody} ` }, 'master-secret');
  assert.equal(first, second);
  assert.notEqual(first, changed);

  const key1 = await deriveDeviceSigningKey('master-secret', input.deviceId, 1);
  const key2 = await deriveDeviceSigningKey('master-secret', input.deviceId, 2);
  assert.notDeepEqual(key1, key2);

  const bodyHash = await sha256Hex(input.rawBody);
  assert.equal(
    buildDeviceCanonicalRequest({ ...input, bodyHash }),
    `POST\n/api/v2/device/telemetry\nBB-00000001\n1800000000\n7\n${bodyHash}`,
  );
});

test('device signing key can use a self-hosted provisioned-key map', async () => {
  const derived = await deriveDeviceSigningKey('master-secret', 'BB-00000001', 1);
  const provisionedMap = JSON.stringify({
    'BB-00000001:v1': hex(derived),
  });
  assert.deepEqual(
    await deriveDeviceSigningKey(provisionedMap, 'BB-00000001', 1),
    derived,
  );
  await assert.rejects(
    deriveDeviceSigningKey(provisionedMap, 'BB-00000002', 1),
    /No provisioned signing key/u,
  );
});

test('device signature: server verifies active credential and rejects replay sequence', async () => {
  const nowMs = 1_800_000_000_000;
  const rawBody = '{"device_id":"BB-00000001","sequence":7}';
  const signatureInput = {
    method: 'POST',
    pathname: '/api/v2/device/telemetry',
    deviceId: 'BB-00000001',
    timestamp: Math.floor(nowMs / 1000),
    sequence: 7,
    keyVersion: 1,
    rawBody,
  };
  const signature = await signDeviceRequest(signatureInput, 'master-secret');
  const request = new Request('https://api.example/api/v2/device/telemetry', {
    method: 'POST',
    headers: {
      'X-BikeBoss-Timestamp': String(signatureInput.timestamp),
      'X-BikeBoss-Sequence': '7',
      'X-BikeBoss-Key-Version': '1',
      'X-BikeBoss-Signature': signature,
    },
    body: rawBody,
  });
  const env = {
    DEVICE_KEY_MASTER: 'master-secret',
    DEVICE_REQUEST_MAX_SKEW_SECONDS: 300,
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ status: 'active', last_sequence: 6 }),
        }),
      }),
    },
  };
  const valid = await verifyDeviceRequestSignature(request, rawBody, 'BB-00000001', env, { nowMs });
  assert.equal(valid.ok, true);
  assert.equal(valid.sequence, 7);
  assert.equal(valid.lastSequence, 6);

  env.DB.prepare = () => ({
    bind: () => ({ first: async () => ({ status: 'active', last_sequence: 7 }) }),
  });
  const replay = await verifyDeviceRequestSignature(request, rawBody, 'BB-00000001', env, { nowMs });
  assert.equal(replay.ok, false);
  assert.equal(replay.error, 'device_replay');
});

test('device signature: compact auth header verifies without four repeated header names', async () => {
  const nowMs = 1_800_000_000_000;
  const rawBody = '{"v":2,"id":"BB-00000001","q":8}';
  const input = {
    method: 'POST',
    pathname: '/api/v2/device/telemetry',
    deviceId: 'BB-00000001',
    timestamp: Math.floor(nowMs / 1000),
    sequence: 8,
    keyVersion: 1,
    rawBody,
  };
  const signature = await signDeviceRequest(input, 'master-secret');
  const request = new Request('https://api.example/api/v2/device/telemetry', {
    method: 'POST',
    headers: {
      'X-BikeBoss-Auth': `${input.timestamp}.${input.sequence}.1.${signature}`,
    },
    body: rawBody,
  });
  const env = {
    DEVICE_KEY_MASTER: 'master-secret',
    DEVICE_REQUEST_MAX_SKEW_SECONDS: 300,
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ status: 'active', last_sequence: 7 }),
        }),
      }),
    },
  };
  const result = await verifyDeviceRequestSignature(request, rawBody, input.deviceId, env, { nowMs });
  assert.equal(result.ok, true);
  assert.equal(result.sequence, 8);
  assert.equal(result.lastSequence, 7);
});
