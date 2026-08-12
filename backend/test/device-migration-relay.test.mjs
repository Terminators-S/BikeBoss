import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceMigrationRelayUrl } from '../src/index.js';

const origin = 'https://bikeboss.creative-studio.blog';

test('migration relay targets only device-originated API paths', () => {
  assert.equal(
    deviceMigrationRelayUrl(
      'https://bikeboss-api-staging.example.workers.dev/api/v2/device/telemetry?source=ota',
      origin,
    ).href,
    'https://bikeboss.creative-studio.blog/api/v2/device/telemetry?source=ota',
  );
  assert.equal(
    deviceMigrationRelayUrl(
      'https://bikeboss-api-staging.example.workers.dev/api/v1/crash',
      origin,
    ).href,
    'https://bikeboss.creative-studio.blog/api/v1/crash',
  );
  assert.equal(
    deviceMigrationRelayUrl(
      'https://bikeboss-api-staging.example.workers.dev/api/v2/me',
      origin,
    ),
    null,
  );
  assert.equal(
    deviceMigrationRelayUrl(
      'https://bikeboss-api-staging.example.workers.dev/webhook/telegram',
      origin,
    ),
    null,
  );
});

test('migration relay rejects unsafe origins and recursion', () => {
  assert.throws(
    () => deviceMigrationRelayUrl(
      'https://bikeboss-api-staging.example.workers.dev/api/v2/device/telemetry',
      'http://bikeboss.creative-studio.blog',
    ),
    /HTTPS origin/u,
  );
  assert.equal(
    deviceMigrationRelayUrl(
      'https://bikeboss.creative-studio.blog/api/v2/device/telemetry',
      origin,
    ),
    null,
  );
});
