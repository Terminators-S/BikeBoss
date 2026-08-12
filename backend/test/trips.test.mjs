import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideTripAction,
  isTripMovement,
  TRIP_RULES,
} from '../src/lib/trips.js';

function sample(at, overrides = {}) {
  return {
    device_id: 'BB-00000001',
    gps_fix: 1,
    gps_lat: 11.55,
    gps_lon: 104.91,
    gps_speed: 0,
    motion_state: 'stationary',
    captured_at: at,
    ...overrides,
  };
}

function trip(overrides = {}) {
  return {
    id: 1,
    device_id: 'BB-00000001',
    start_time: '2026-08-10T01:00:00Z',
    last_moving_at: '2026-08-10T01:01:00Z',
    stationary_since: null,
    ...overrides,
  };
}

test('a trip starts at the same movement threshold used by firmware', () => {
  const gpsMovement = sample('2026-08-10T01:00:00Z', {
    gps_speed: TRIP_RULES.startSpeedKmh,
  });
  const imuMovement = sample('2026-08-10T01:00:00Z', {
    motion_state: 'moving',
  });
  assert.equal(isTripMovement(gpsMovement), true);
  assert.equal(decideTripAction({ ongoing: null, previous: null, sample: gpsMovement }).type, 'start');
  assert.equal(decideTripAction({ ongoing: null, previous: null, sample: imuMovement }).type, 'start');
});

test('a brief stop remains inside the active trip', () => {
  const ongoing = trip({ stationary_since: '2026-08-10T01:02:00Z' });
  const previous = sample('2026-08-10T01:02:30Z');
  const current = sample('2026-08-10T01:04:59Z');
  assert.equal(decideTripAction({ ongoing, previous, sample: current }).type, 'continue');
});

test('a sustained stop closes at the first stationary sample', () => {
  const stationarySince = '2026-08-10T01:02:00Z';
  const ongoing = trip({ stationary_since: stationarySince });
  const previous = sample('2026-08-10T01:04:30Z');
  const current = sample('2026-08-10T01:05:00Z');
  const decision = decideTripAction({ ongoing, previous, sample: current });
  assert.equal(decision.type, 'close');
  assert.equal(decision.endAt, stationarySince);
});

test('movement after a long telemetry gap closes the old trip and starts another', () => {
  const ongoing = trip();
  const previous = sample('2026-08-10T01:01:00Z', {
    gps_speed: 20,
    motion_state: 'moving',
  });
  const current = sample('2026-08-10T01:06:01Z', {
    gps_speed: 15,
    motion_state: 'moving',
  });
  assert.equal(
    decideTripAction({ ongoing, previous, sample: current }).type,
    'close_then_start',
  );
});
