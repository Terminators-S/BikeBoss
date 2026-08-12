import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signDeviceRequest } from '../src/lib/auth.js';
import {
  handleTelemetryBatchV2,
  handleTelemetryV2,
} from '../src/routes/telemetry.js';

function createEnvironment(lastSequence, gpsReference = null) {
  const statements = [];
  const prepare = (sql) => {
    const statement = {
      sql,
      values: [],
      bind(...values) {
        this.values = values;
        statements.push(this);
        return this;
      },
      async first() {
        if (sql.includes('FROM device_credentials')) {
          return { status: 'active', last_sequence: lastSequence };
        }
        if (sql.includes('FROM telemetry')) return gpsReference;
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  };
  return {
    statements,
    env: {
      DEVICE_KEY_MASTER: 'master-secret',
      DEVICE_REQUEST_MAX_SKEW_SECONDS: 1_000_000_000,
      DB: {
        prepare,
        async batch(batchStatements) {
          for (const statement of batchStatements) await statement.run();
          return batchStatements.map(() => ({ success: true }));
        },
      },
    },
  };
}

async function signedRequest(pathname, body, sequence, nowMs) {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(nowMs / 1_000);
  const signature = await signDeviceRequest({
    method: 'POST',
    pathname,
    deviceId: 'BB-00000001',
    timestamp,
    sequence,
    keyVersion: 1,
    rawBody,
  }, 'master-secret');
  return {
    rawBody,
    request: new Request(`https://api.example${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BikeBoss-Auth': `${timestamp}.${sequence}.1.${signature}`,
      },
      body: rawBody,
    }),
  };
}

function compactPoint(sequence) {
  return {
    v: 2,
    id: 'BB-00000001',
    q: sequence,
    t: 1_800_000_000 + sequence,
    a: 0,
    g: [0],
    m: [1, 0, 979, 0],
    b: 12_600,
    c: 0,
    u: [2, null, 'Test mobile'],
  };
}

test('signed compact handler persists normalized telemetry and returns a tiny response', async () => {
  const nowMs = 1_800_000_100_000;
  const body = compactPoint(42);
  const { request, rawBody } = await signedRequest(
    '/api/v2/device/telemetry',
    body,
    42,
    nowMs,
  );
  const { env, statements } = createEnvironment(41);
  const background = [];
  const response = await handleTelemetryV2(request, rawBody, body, env, {
    waitUntil(promise) { background.push(promise); },
  });
  await Promise.all(background);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: 1, q: 42, c: [] });
  const insert = statements.find((statement) => statement.sql.includes('INSERT INTO telemetry'));
  assert.ok(insert, 'telemetry insert prepared');
  assert.equal(insert.values[0], 'BB-00000001');
  assert.equal(insert.values[19], 'BB-00000001-42');
  assert.equal(insert.values[20], 42);
  assert.equal(insert.values[21], '2027-01-15T08:00:42.000Z');
  assert.equal(insert.values[34], 'cellular');
  assert.equal(insert.values[35], null);
  assert.equal(insert.values[36], '4g');
  assert.equal(insert.values[37], 'Test mobile');
});

test('signed handler stores an impossible GPS jump as no-fix evidence', async () => {
  const nowMs = 1_800_000_100_000;
  const body = compactPoint(42);
  body.g = [1, 116_382_620, 1_026_500_030, 0, 30, 6, 18, 0, 0];
  const { request, rawBody } = await signedRequest(
    '/api/v2/device/telemetry',
    body,
    42,
    nowMs,
  );
  const { env, statements } = createEnvironment(41, {
    gps_lat: 11.641214,
    gps_lon: 104.919744,
    gps_accuracy_m: 3,
    gps_hdop: 0.6,
    gps_satellites: 18,
    captured_at: '2027-01-15T08:00:37.000Z',
    received_at: '2027-01-15 08:00:38',
  });
  const response = await handleTelemetryV2(request, rawBody, body, env);
  assert.equal(response.status, 200);
  const insert = statements.find((statement) => statement.sql.includes('INSERT INTO telemetry'));
  assert.ok(insert);
  assert.equal(insert.values[5], 0, 'rejected coordinate cannot become a live GPS fix');
  assert.equal(insert.values[4], 0, 'rejected coordinate cannot expose corrupt GPS speed');
  assert.equal(insert.values[3], 102.650003, 'raw coordinate remains available for diagnosis');
});

test('signed batch handler atomically accepts ascending offline samples', async () => {
  const nowMs = 1_800_000_100_000;
  const first = compactPoint(41);
  const second = compactPoint(42);
  delete first.v;
  delete first.id;
  delete second.v;
  delete second.id;
  const body = { v: 2, id: 'BB-00000001', q: 42, p: [first, second] };
  const { request, rawBody } = await signedRequest(
    '/api/v2/device/telemetry/batch',
    body,
    42,
    nowMs,
  );
  const { env, statements } = createEnvironment(40);
  const background = [];
  const response = await handleTelemetryBatchV2(request, rawBody, body, env, {
    waitUntil(promise) { background.push(promise); },
  });
  await Promise.all(background);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: 1, q: 42, c: [] });
  const inserts = statements.filter((statement) => statement.sql.includes('INSERT INTO telemetry'));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map((statement) => statement.values[20]), [41, 42]);
});

test('offline replay rejects one GPS teleport and preserves the following valid point', async () => {
  const nowMs = 1_800_000_100_000;
  const points = [compactPoint(41), compactPoint(42), compactPoint(43)];
  points[0].g = [1, 116_412_140, 1_049_197_440, 0, 30, 6, 18, 0, 0];
  points[1].g = [1, 116_382_620, 1_026_500_030, 0, 30, 6, 18, 0, 0];
  points[2].g = [1, 116_412_190, 1_049_197_760, 0, 30, 6, 18, 0, 0];
  for (const point of points) {
    delete point.v;
    delete point.id;
  }
  const body = { v: 2, id: 'BB-00000001', q: 43, p: points };
  const { request, rawBody } = await signedRequest(
    '/api/v2/device/telemetry/batch',
    body,
    43,
    nowMs,
  );
  const { env, statements } = createEnvironment(40, {
    gps_lat: 11.6412,
    gps_lon: 104.9197,
    gps_accuracy_m: 3,
    gps_hdop: 0.6,
    gps_satellites: 18,
    captured_at: '2027-01-15T08:00:40.000Z',
    received_at: '2027-01-15 08:00:40',
  });
  const response = await handleTelemetryBatchV2(request, rawBody, body, env);
  assert.equal(response.status, 200);
  const inserts = statements.filter((statement) => statement.sql.includes('INSERT INTO telemetry'));
  assert.deepEqual(inserts.map((statement) => statement.values[20]), [41, 42, 43]);
  assert.deepEqual(
    inserts.map((statement) => statement.values[5]),
    [1, 0, 1],
    'the corrupt middle point is evidence-only and cannot poison the next fix',
  );
});

test('signed batch resumes after an already-committed prefix without losing newer samples', async () => {
  const nowMs = 1_800_000_100_000;
  const first = compactPoint(41);
  const second = compactPoint(42);
  delete first.v;
  delete first.id;
  delete second.v;
  delete second.id;
  const body = { v: 2, id: 'BB-00000001', q: 42, p: [first, second] };
  const { request, rawBody } = await signedRequest(
    '/api/v2/device/telemetry/batch',
    body,
    42,
    nowMs,
  );
  const { env, statements } = createEnvironment(41);
  const background = [];
  const response = await handleTelemetryBatchV2(request, rawBody, body, env, {
    waitUntil(promise) { background.push(promise); },
  });
  await Promise.all(background);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: 1, q: 42, c: [] });
  const inserts = statements.filter((statement) => statement.sql.includes('INSERT INTO telemetry'));
  assert.equal(inserts.length, 1, 'the already-committed prefix is skipped before preparing inserts');
  assert.equal(inserts[0].values[20], 42);
});
