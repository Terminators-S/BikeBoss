import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessGpsSample,
  gpsConfidence,
  robustGpsAnchor,
} from '../src/lib/gps-sanity.js';

const reference = {
  lat: 11.641214,
  lon: 104.919744,
  accuracyM: 3,
  hdop: 0.6,
  sampledAt: '2026-08-11T05:44:38Z',
};

test('GPS sanity accepts ordinary road movement', () => {
  const result = assessGpsSample({
    lat: 11.642,
    lon: 104.9202,
    accuracyM: 5,
    hdop: 1,
    sampledAt: '2026-08-11T05:44:43Z',
  }, reference);
  assert.equal(result.ok, true);
});

test('GPS sanity rejects the observed 11,000 km serial-corruption jump', () => {
  const result = assessGpsSample({
    lat: 0.25,
    lon: 0.383333,
    accuracyM: 100,
    hdop: 29,
    sampledAt: '2026-08-11T05:44:43Z',
  }, reference);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'hdop_unusable');
});

test('GPS sanity rejects a huge jump even when reported quality looks good', () => {
  const result = assessGpsSample({
    lat: 11.638262,
    lon: 102.650003,
    accuracyM: 3,
    hdop: 0.6,
    sampledAt: '2026-08-11T05:44:43Z',
  }, reference);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'impossible_jump');
  assert.ok(result.distanceM > 200_000);
});

test('GPS sanity allows a distant fix after a proportionate offline interval', () => {
  const result = assessGpsSample({
    lat: 11.69,
    lon: 104.95,
    accuracyM: 10,
    hdop: 1.5,
    sampledAt: '2026-08-11T05:49:38Z',
  }, reference);
  assert.equal(result.ok, true);
});

test('GPS confidence rewards precise multi-satellite fixes', () => {
  const strong = gpsConfidence({ ...reference, satellites: 14 });
  const weak = gpsConfidence({
    ...reference, accuracyM: 80, hdop: 9, satellites: 3,
  });
  assert.ok(strong > 0.9);
  assert.ok(weak < 0.35);
});

test('robust stationary consensus suppresses a plausible-looking drift false positive', () => {
  const stationaryHistory = [
    [11.641214, 104.919744],
    [11.641219, 104.919750],
    [11.641208, 104.919739],
    [11.641216, 104.919747],
  ].map(([lat, lon], index) => ({
    lat, lon, accuracyM: 4, hdop: 0.8, satellites: 12,
    speedKmh: 0, motionState: 'stationary',
    sampledAt: `2026-08-11T05:44:${30 + index}Z`,
  }));
  const anchor = robustGpsAnchor(stationaryHistory);
  assert.equal(anchor.sampleCount, 4);

  const result = assessGpsSample({
    lat: 11.6422,
    lon: 104.919744,
    accuracyM: 5,
    hdop: 0.9,
    satellites: 12,
    speedKmh: 0,
    motionState: 'stationary',
    sampledAt: '2026-08-11T05:44:40Z',
  }, stationaryHistory.at(-1), { stationaryHistory });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stationary_drift');
  assert.ok(result.confidence > 0.9, 'even good-looking GNSS can drift while the IMU is still');
});

test('stationary consensus does not suppress genuine IMU-confirmed movement', () => {
  const stationaryHistory = [0, 1, 2].map((offset) => ({
    ...reference,
    lon: reference.lon + offset * 0.000002,
    speedKmh: 0,
    motionState: 'stationary',
  }));
  const result = assessGpsSample({
    lat: 11.6422,
    lon: 104.919744,
    accuracyM: 5,
    hdop: 0.9,
    satellites: 12,
    speedKmh: 18,
    motionState: 'moving',
    sampledAt: '2026-08-11T05:44:43Z',
  }, reference, { stationaryHistory });
  assert.equal(result.ok, true);
});
