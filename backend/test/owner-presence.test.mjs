import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTrustedOwnerPresence } from '../src/lib/geofence.js';

test('owner presence suppresses only fresh authenticated high-confidence observations', () => {
  assert.equal(isTrustedOwnerPresence({
    authenticated: true,
    connected: true,
    age_seconds: 8,
    confidence: 0.9,
  }), true);
  assert.equal(isTrustedOwnerPresence({
    authenticated: false,
    connected: true,
    age_seconds: 1,
    confidence: 1,
  }), false, 'an arbitrary BLE client must never silence a theft alert');
  assert.equal(isTrustedOwnerPresence({
    authenticated: true,
    connected: true,
    age_seconds: 31,
    confidence: 0.9,
  }), false, 'stale presence must fail closed');
  assert.equal(isTrustedOwnerPresence({
    authenticated: true,
    connected: true,
    age_seconds: 3,
    confidence: 0.69,
  }), false, 'low-confidence presence must fail closed');
});
