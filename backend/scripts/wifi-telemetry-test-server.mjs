import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { normalizeTelemetryEnvelope } from '../src/lib/telemetry-codec.js';

const host = process.env.BIKEBOSS_WIFI_TEST_BIND ?? '0.0.0.0';
const port = Number(process.env.BIKEBOSS_WIFI_TEST_PORT ?? 8787);
// Public test fixture only. It is never accepted by the deployed Worker.
const keyHex = process.env.BIKEBOSS_WIFI_TEST_KEY_HEX
  ?? '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

if (!/^[0-9a-f]{64}$/iu.test(keyHex)) {
  throw new Error('BIKEBOSS_WIFI_TEST_KEY_HEX must contain exactly 64 hex characters');
}

const signingKey = Buffer.from(keyHex, 'hex');

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function signatureMatches(expected, received) {
  try {
    const expectedBytes = Buffer.from(expected, 'base64url');
    const receivedBytes = Buffer.from(received, 'base64url');
    return expectedBytes.length === receivedBytes.length
      && timingSafeEqual(expectedBytes, receivedBytes);
  } catch {
    return false;
  }
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    json(response, 200, { ok: 1, service: 'bikeboss-wifi-telemetry-test' });
    return;
  }
  if (request.method === 'POST' && request.url === '/api/v1/telemetry') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        json(response, 400, { error: 'invalid_json' });
        return;
      }
      process.stdout.write(`${JSON.stringify({
        event: 'legacy_telemetry_accepted',
        device_id: body.device_id ?? null,
      })}\n`);
      json(response, 200, {
        status: 'ok',
        device_id: body.device_id ?? null,
        commands: [],
      });
    });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/api/v2/device/telemetry') {
    json(response, 404, { error: 'not_found' });
    return;
  }

  const chunks = [];
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= 512) chunks.push(chunk);
  });
  request.on('end', () => {
    if (bytes > 512) {
      json(response, 413, { error: 'request_too_large' });
      return;
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      json(response, 400, { error: 'invalid_json' });
      return;
    }

    const normalized = normalizeTelemetryEnvelope(body);
    if (!normalized.ok || normalized.format !== 'compact') {
      json(response, 400, { error: normalized.error ?? 'compact_required' });
      return;
    }

    const auth = String(request.headers['x-bikeboss-auth'] ?? '').split('.');
    if (auth.length !== 4) {
      json(response, 401, { error: 'device_auth_missing' });
      return;
    }
    const [timestampText, sequenceText, keyVersionText, receivedSignature] = auth;
    const timestamp = Number(timestampText);
    const sequence = Number(sequenceText);
    if (!Number.isSafeInteger(timestamp)
        || !Number.isSafeInteger(sequence)
        || keyVersionText !== '1'
        || sequence !== normalized.value.sequence
        || Math.abs(Math.floor(Date.now() / 1_000) - timestamp) > 600) {
      json(response, 401, { error: 'device_auth_invalid' });
      return;
    }

    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    const canonical = [
      'POST',
      '/api/v2/device/telemetry',
      normalized.value.device_id,
      timestampText,
      sequenceText,
      bodyHash,
    ].join('\n');
    const expectedSignature = createHmac('sha256', signingKey)
      .update(canonical)
      .digest('base64url');
    if (!signatureMatches(expectedSignature, receivedSignature)) {
      json(response, 401, { error: 'device_auth_invalid' });
      return;
    }

    const gps = normalized.value.gps;
    process.stdout.write(`${JSON.stringify({
      event: 'compact_telemetry_accepted',
      device_id: normalized.value.device_id,
      sequence,
      bytes,
      gps_fix: gps.fix,
      lat: gps.lat,
      lon: gps.lon,
      accuracy_m: gps.accuracy_m,
    })}\n`);
    json(response, 200, { ok: 1, q: sequence, c: [] });
  });
});

server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ event: 'wifi_test_server_ready', host, port })}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
