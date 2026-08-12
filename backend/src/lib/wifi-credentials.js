import { deriveDeviceSigningKey } from './auth.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONFIG_KEY_CONTEXT = 'bikeboss:wifi-profile:v1';

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value) {
  const padded = String(value).replaceAll('-', '+').replaceAll('_', '/')
    .padEnd(Math.ceil(String(value).length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveWifiConfigKey(masterSecret, deviceId, keyVersion) {
  const deviceSigningKey = await deriveDeviceSigningKey(masterSecret, deviceId, keyVersion);
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    deviceSigningKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    encoder.encode(CONFIG_KEY_CONTEXT),
  ));
}

function additionalData(deviceId, profileId, version, keyVersion) {
  return encoder.encode(`${deviceId}|${profileId}|${version}|${keyVersion}`);
}

export async function encryptWifiProfile({
  masterSecret,
  deviceId,
  profileId,
  version,
  keyVersion,
  profile,
}) {
  const rawKey = await deriveWifiConfigKey(masterSecret, deviceId, keyVersion);
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(profile));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: nonce,
    additionalData: additionalData(deviceId, profileId, version, keyVersion),
    tagLength: 128,
  }, key, plaintext);
  return {
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptWifiProfile({
  masterSecret,
  deviceId,
  profileId,
  version,
  keyVersion,
  nonce,
  ciphertext,
}) {
  const rawKey = await deriveWifiConfigKey(masterSecret, deviceId, keyVersion);
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: base64UrlToBytes(nonce),
    additionalData: additionalData(deviceId, profileId, version, keyVersion),
    tagLength: 128,
  }, key, base64UrlToBytes(ciphertext));
  return JSON.parse(decoder.decode(plaintext));
}

export function validateWifiProfileInput(input, { partial = false } = {}) {
  const result = {};
  const has = (key) => Object.hasOwn(input ?? {}, key);

  if (!partial || has('label')) {
    const label = String(input?.label ?? '').trim();
    if (!label || label.length > 40 || /[\u0000-\u001f\u007f]/u.test(label)) {
      return { ok: false, error: 'wifi_label_invalid' };
    }
    result.label = label;
  }

  if (!partial || has('ssid')) {
    const ssid = String(input?.ssid ?? '');
    const ssidBytes = encoder.encode(ssid).byteLength;
    if (!ssid || ssidBytes > 32 || /[\u0000\r\n]/u.test(ssid)) {
      return { ok: false, error: 'wifi_ssid_invalid' };
    }
    result.ssid = ssid;
  }

  if (!partial || has('password')) {
    const password = String(input?.password ?? '');
    const passwordBytes = encoder.encode(password).byteLength;
    if (passwordBytes !== 0 && (passwordBytes < 8 || passwordBytes > 63)) {
      return { ok: false, error: 'wifi_password_invalid' };
    }
    result.password = password;
  }

  if (!partial || has('priority')) {
    const priority = Number(input?.priority ?? 50);
    if (!Number.isSafeInteger(priority) || priority < 1 || priority > 100) {
      return { ok: false, error: 'wifi_priority_invalid' };
    }
    result.priority = priority;
  }

  return { ok: true, value: result };
}

export function serializeWifiProfile(row, decrypted) {
  return {
    id: row.profile_uuid,
    label: row.label,
    ssid: decrypted?.ssid ?? null,
    priority: Number(row.priority),
    status: row.status,
    version: Number(row.version),
    last_connected_at: row.last_connected_at,
    last_failed_at: row.last_failed_at,
    success_count: Number(row.success_count ?? 0),
    failure_count: Number(row.failure_count ?? 0),
    learned_location: row.learned_lat == null || row.learned_lon == null ? null : {
      lat: Number(row.learned_lat),
      lon: Number(row.learned_lon),
      radius_m: Number(row.learned_radius_m ?? 0),
      observations: Number(row.observation_count ?? 0),
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function buildEncryptedWifiSyncPayload(deviceId, revision, env) {
  const result = await env.DB.prepare(
    `SELECT profile_uuid, version, key_version, credential_nonce,
            credential_ciphertext
     FROM wifi_profiles
     WHERE device_id = ? AND status = 'active'
     ORDER BY priority DESC, created_at ASC LIMIT 8`
  ).bind(deviceId).all();
  return {
    r: Number(revision),
    p: (result.results ?? []).map((profile) => [
      profile.profile_uuid,
      Number(profile.version),
      Number(profile.key_version),
      profile.credential_nonce,
      profile.credential_ciphertext,
    ]),
  };
}
