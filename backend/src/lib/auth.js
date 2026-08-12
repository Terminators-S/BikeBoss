const encoder = new TextEncoder();
const TELEGRAM_KEY_LABEL = 'WebAppData';

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function base64UrlToBytes(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hexToBytes(value) {
  if (!/^[0-9a-f]{64}$/iu.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

async function importHmacKey(rawKey, usages = ['sign']) {
  const bytes = typeof rawKey === 'string' ? encoder.encode(rawKey) : rawKey;
  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

async function hmacBytes(rawKey, value) {
  const key = await importHmacKey(rawKey);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return new Uint8Array(signature);
}

async function verifyHmac(rawKey, value, signature) {
  const key = await importHmacKey(rawKey, ['verify']);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(value));
}

function parseTelegramUser(rawUser) {
  try {
    const user = JSON.parse(rawUser);
    if (!Number.isSafeInteger(Number(user.id))) return null;
    return {
      id: String(user.id),
      firstName: typeof user.first_name === 'string' ? user.first_name : '',
      lastName: typeof user.last_name === 'string' ? user.last_name : '',
      username: typeof user.username === 'string' ? user.username : null,
      languageCode: typeof user.language_code === 'string' ? user.language_code : null,
    };
  } catch {
    return null;
  }
}

/**
 * Validate Telegram Mini App initData using the bot-token HMAC flow documented
 * by Telegram. No field from initData is trusted until this succeeds.
 */
export async function validateTelegramInitData(initData, botToken, {
  nowMs = Date.now(),
  maxAgeSeconds = 300,
} = {}) {
  if (typeof initData !== 'string' || !initData || !botToken) {
    return { ok: false, error: 'telegram_auth_missing' };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const rawUser = params.get('user');
  const signatureBytes = hash ? hexToBytes(hash) : null;

  if (!signatureBytes || !Number.isSafeInteger(authDate) || !rawUser) {
    return { ok: false, error: 'telegram_auth_invalid' };
  }

  const ageSeconds = Math.floor(nowMs / 1000) - authDate;
  if (ageSeconds < -30 || ageSeconds > maxAgeSeconds) {
    return { ok: false, error: 'telegram_auth_expired' };
  }

  const fields = [];
  const seen = new Set();
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    if (seen.has(key)) return { ok: false, error: 'telegram_auth_invalid' };
    seen.add(key);
    fields.push(`${key}=${value}`);
  }
  fields.sort((left, right) => left.localeCompare(right));
  const dataCheckString = fields.join('\n');

  // Telegram: secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
  const secretKey = await hmacBytes(TELEGRAM_KEY_LABEL, botToken);
  const valid = await verifyHmac(secretKey, dataCheckString, signatureBytes);
  if (!valid) return { ok: false, error: 'telegram_auth_invalid' };

  const user = parseTelegramUser(rawUser);
  if (!user) return { ok: false, error: 'telegram_user_invalid' };
  return { ok: true, user, authDate };
}

export async function createSessionToken(actor, secret, {
  nowMs = Date.now(),
  ttlSeconds = 900,
} = {}) {
  if (!secret) throw new Error('APP_SESSION_SECRET is not configured');
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = {
    v: 1,
    sid: crypto.randomUUID(),
    uid: Number(actor.userId),
    sub: String(actor.telegramId),
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacBytes(secret, encodedPayload);
  return `${encodedPayload}.${bytesToBase64Url(signature)}`;
}

export async function verifySessionToken(token, secret, { nowMs = Date.now() } = {}) {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  let signature;
  let payload;
  try {
    signature = base64UrlToBytes(parts[1]);
    const payloadBytes = base64UrlToBytes(parts[0]);
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }

  const valid = await verifyHmac(secret, parts[0], signature);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!valid
      || payload?.v !== 1
      || !Number.isSafeInteger(payload.uid)
      || typeof payload.sub !== 'string'
      || !Number.isSafeInteger(payload.iat)
      || !Number.isSafeInteger(payload.exp)
      || payload.iat > nowSeconds + 30
      || payload.exp <= nowSeconds) {
    return null;
  }

  return {
    sessionId: payload.sid,
    userId: payload.uid,
    telegramId: payload.sub,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

export async function authenticateUserRequest(request, env) {
  const authorization = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  if (!match) return null;
  return verifySessionToken(match[1], env.APP_SESSION_SECRET);
}

export async function sha256Hex(value) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function buildDeviceCanonicalRequest({
  method,
  pathname,
  deviceId,
  timestamp,
  sequence,
  bodyHash,
}) {
  return [
    method.toUpperCase(),
    pathname,
    deviceId,
    String(timestamp),
    String(sequence),
    bodyHash,
  ].join('\n');
}

/** Derive a unique per-device/version signing key from a Worker master secret. */
export async function deriveDeviceSigningKey(masterSecret, deviceId, keyVersion) {
  if (!masterSecret) throw new Error('DEVICE_KEY_MASTER is not configured');
  // Self-hosted migrations cannot read an existing Cloudflare Worker secret
  // back from the platform. A JSON object may therefore contain already-
  // provisioned per-device keys, keyed as "DEVICE_ID:vVERSION". The value is
  // kept only in the server secret file and never in source control.
  if (typeof masterSecret === 'string' && masterSecret.trimStart().startsWith('{')) {
    let provisionedKeys;
    try {
      provisionedKeys = JSON.parse(masterSecret);
    } catch {
      throw new Error('DEVICE_KEY_MASTER provisioned-key map is invalid JSON');
    }
    const directKey = hexToBytes(provisionedKeys?.[`${deviceId}:v${keyVersion}`]);
    if (!directKey) throw new Error(`No provisioned signing key for ${deviceId}:v${keyVersion}`);
    return directKey;
  }
  return hmacBytes(masterSecret, `${deviceId}:v${keyVersion}`);
}

export async function signDeviceRequest(input, masterSecret) {
  const derivedKey = await deriveDeviceSigningKey(
    masterSecret,
    input.deviceId,
    input.keyVersion,
  );
  const bodyHash = await sha256Hex(input.rawBody);
  const canonical = buildDeviceCanonicalRequest({ ...input, bodyHash });
  return bytesToBase64Url(await hmacBytes(derivedKey, canonical));
}

export async function verifyDeviceRequestSignature(request, rawBody, deviceId, env, {
  nowMs = Date.now(),
  enforceReplay = true,
} = {}) {
  const compactAuth = request.headers.get('X-BikeBoss-Auth');
  const compactParts = compactAuth ? compactAuth.split('.') : [];
  const timestamp = Number(compactParts.length === 4
    ? compactParts[0]
    : request.headers.get('X-BikeBoss-Timestamp'));
  const sequence = Number(compactParts.length === 4
    ? compactParts[1]
    : request.headers.get('X-BikeBoss-Sequence'));
  const keyVersion = Number(compactParts.length === 4
    ? compactParts[2]
    : request.headers.get('X-BikeBoss-Key-Version'));
  const signatureValue = compactParts.length === 4
    ? compactParts[3]
    : request.headers.get('X-BikeBoss-Signature');

  if (!Number.isSafeInteger(timestamp)
      || !Number.isSafeInteger(sequence) || sequence < 0
      || !Number.isSafeInteger(keyVersion) || keyVersion < 1
      || !signatureValue) {
    return { ok: false, error: 'device_auth_missing' };
  }

  const maxSkewSeconds = Number(env.DEVICE_REQUEST_MAX_SKEW_SECONDS ?? 300);
  const skewSeconds = Math.abs(Math.floor(nowMs / 1000) - timestamp);
  if (skewSeconds > maxSkewSeconds) {
    return { ok: false, error: 'device_clock_skew' };
  }

  let signature;
  try {
    signature = base64UrlToBytes(signatureValue);
  } catch {
    return { ok: false, error: 'device_auth_invalid' };
  }

  const credential = await env.DB.prepare(
    `SELECT status, last_sequence FROM device_credentials
     WHERE device_id = ? AND key_version = ?`
  ).bind(deviceId, keyVersion).first();
  if (!credential || credential.status !== 'active') {
    return { ok: false, error: 'device_credential_inactive' };
  }
  if (enforceReplay && sequence <= Number(credential.last_sequence)) {
    return { ok: false, error: 'device_replay' };
  }

  const bodyHash = await sha256Hex(rawBody);
  const canonical = buildDeviceCanonicalRequest({
    method: request.method,
    pathname: new URL(request.url).pathname,
    deviceId,
    timestamp,
    sequence,
    bodyHash,
  });
  const derivedKey = await deriveDeviceSigningKey(env.DEVICE_KEY_MASTER, deviceId, keyVersion);
  const valid = await verifyHmac(derivedKey, canonical, signature);
  return valid
    ? {
      ok: true,
      keyVersion,
      sequence,
      timestamp,
      lastSequence: Number(credential.last_sequence),
    }
    : { ok: false, error: 'device_auth_invalid' };
}
