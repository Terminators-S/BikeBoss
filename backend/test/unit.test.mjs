/**
 * Pure-logic unit tests — run with `node --test test/`.
 * No Cloudflare runtime needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { haversineDistance, toRadians } from '../src/lib/geo.js';
import {
  accelMagnitude, gyroMagnitude, ema, scoreTrip,
  advanceGpsSpeedFilter, calibrateGravityVector, projectOntoUpright,
  CRASH_IMPACT_THRESHOLD, CRASH_ROTATION_THRESHOLD, CRASH_FLAT_Z_THRESHOLD,
} from '../src/lib/imu.js';

// ---------------------------------------------------------------------------
// geo.js
// ---------------------------------------------------------------------------

test('haversine: identical points → 0m', () => {
  assert.equal(haversineDistance(11.5564, 104.9282, 11.5564, 104.9282), 0);
});

test('haversine: ~111.19km per degree latitude at equator', () => {
  const d = haversineDistance(0, 0, 1, 0);
  assert.ok(Math.abs(d - 111195) < 100, `expected ~111195m, got ${d}`);
});

test('haversine: Phnom Penh → small offset is sub-km', () => {
  // ~0.001° lat ≈ 111m
  const d = haversineDistance(11.5564, 104.9282, 11.5574, 104.9282);
  assert.ok(d > 100 && d < 120, `expected ~111m, got ${d}`);
});

test('haversine: geofence breach boundary — 150m away exceeds 100m radius', () => {
  // 0.00135° lat ≈ 150m
  const d = haversineDistance(11.5564, 104.9282, 11.55775, 104.9282);
  assert.ok(d > 100, `distance ${d} should exceed 100m radius`);
});

test('toRadians', () => {
  assert.ok(Math.abs(toRadians(180) - Math.PI) < 1e-12);
});

// ---------------------------------------------------------------------------
// imu.js — magnitudes
// ---------------------------------------------------------------------------

test('accelMagnitude: resting bike ≈ 9.81 m/s² (gravity on Z)', () => {
  const m = accelMagnitude(0, 0, 9.81);
  assert.ok(Math.abs(m - 9.81) < 1e-9);
});

test('gyroMagnitude: zero rotation', () => {
  assert.equal(gyroMagnitude(0, 0, 0), 0);
});

test('crash stage-1: impact above 19.6 m/s² triggers', () => {
  const m = accelMagnitude(15, 10, 12);
  assert.ok(m > CRASH_IMPACT_THRESHOLD, `${m} should exceed ${CRASH_IMPACT_THRESHOLD}`);
});

test('crash stage-1: pothole-level bump does NOT trigger', () => {
  const m = accelMagnitude(3, 2, 10.5);
  assert.ok(m < CRASH_IMPACT_THRESHOLD);
});

test('crash stage-2: tumbling rotation triggers', () => {
  const g = gyroMagnitude(1.5, 1.2, 1.0);
  assert.ok(g > CRASH_ROTATION_THRESHOLD, `${g} should exceed ${CRASH_ROTATION_THRESHOLD}`);
});

test('gravity-vector calibration keeps a normal lean near 1g, not impact force', () => {
  const calibration = calibrateGravityVector(8, 0, 23.9);
  assert.ok(calibration);
  const leaned = {
    x: 0,
    y: 25.2 * calibration.scale,
    z: 0,
  };
  assert.ok(Math.abs(accelMagnitude(leaned.x, leaned.y, leaned.z) - 9.80665) < 0.02);
  assert.ok(accelMagnitude(leaned.x, leaned.y, leaned.z) < CRASH_IMPACT_THRESHOLD);
  assert.ok(Math.abs(projectOntoUpright(leaned, calibration.upright)) < CRASH_FLAT_Z_THRESHOLD);
});

test('stationary GPS spikes need two consecutive moving fixes', () => {
  let state = advanceGpsSpeedFilter(undefined, 2.9);
  assert.equal(state.speedKmh, 0);
  state = advanceGpsSpeedFilter(state, 52.0);
  assert.equal(state.speedKmh, 0);
  state = advanceGpsSpeedFilter(state, 0);
  assert.equal(state.moving, false);
  state = advanceGpsSpeedFilter(state, 4.0);
  assert.equal(state.speedKmh, 0);
  state = advanceGpsSpeedFilter(state, 5.0);
  assert.equal(state.moving, true);
  assert.equal(state.speedKmh, 5.0);
});

// ---------------------------------------------------------------------------
// imu.js — EMA filter (BLE RSSI)
// ---------------------------------------------------------------------------

test('ema: converges toward repeated samples', () => {
  let smoothed = -90;
  for (let i = 0; i < 50; i++) smoothed = ema(smoothed, -50, 0.2);
  assert.ok(smoothed > -51 && smoothed < -49, `got ${smoothed}`);
});

test('ema: single spike barely moves the average (noise rejection)', () => {
  const before = ema(-70, -70, 0.2);
  const afterSpike = ema(before, -30, 0.2);
  assert.ok(afterSpike < -60, `spike rejected, got ${afterSpike}`);
});

// ---------------------------------------------------------------------------
// imu.js — trip scoring
// ---------------------------------------------------------------------------

test('scoreTrip: perfect smooth ride → 100/100', () => {
  const { safety, eco } = scoreTrip({ hardBrakes: 0, harshAccels: 0, maxSpeedKmh: 50 });
  assert.equal(safety, 100);
  assert.equal(eco, 100);
});

test('scoreTrip: aggressive ride loses points', () => {
  const { safety, eco } = scoreTrip({ hardBrakes: 5, harshAccels: 5, maxSpeedKmh: 95 });
  assert.ok(safety < 60, `safety=${safety}`);
  assert.ok(eco < 100, `eco=${eco}`);
});

test('scoreTrip: never below 0 or above 100', () => {
  const { safety, eco } = scoreTrip({ hardBrakes: 100, harshAccels: 100, maxSpeedKmh: 200 });
  assert.equal(safety, 0);
  assert.ok(eco >= 0 && eco <= 100);
});
