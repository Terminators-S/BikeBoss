import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CIRCLE_POSITION,
  classifyCirclePosition,
} from '../src/lib/geo.js';
import {
  ZONE_STATE,
  ZONE_TRANSITION,
  advanceAllowedZoneState,
} from '../src/lib/geofence-state.js';

const CENTER = { centerLat: 11.6412413, centerLon: 104.9197433, radiusM: 100 };

// At Phnom Penh's latitude, this is approximately 111.2 metres north.
const NORTH_111M = 11.6422413;

test('circle classifier: accuracy makes a near-boundary sample uncertain', () => {
  const result = classifyCirclePosition({
    ...CENTER,
    sampleLat: NORTH_111M,
    sampleLon: CENTER.centerLon,
    accuracyM: 15,
    exitBufferM: 10,
    entryBufferM: 5,
  });
  assert.equal(result.classification, CIRCLE_POSITION.UNCERTAIN);
});

test('circle classifier: entire accuracy radius must be beyond the exit buffer', () => {
  const result = classifyCirclePosition({
    ...CENTER,
    sampleLat: CENTER.centerLat + 0.00135,
    sampleLon: CENTER.centerLon,
    accuracyM: 10,
    exitBufferM: 10,
    entryBufferM: 5,
  });
  assert.equal(result.classification, CIRCLE_POSITION.OUTSIDE);
  assert.ok(result.distanceM > 145 && result.distanceM < 155);
});

test('circle classifier: invalid and zero-radius zones cannot evaluate', () => {
  const result = classifyCirclePosition({
    ...CENTER,
    radiusM: 0,
    sampleLat: CENTER.centerLat,
    sampleLon: CENTER.centerLon,
  });
  assert.equal(result.classification, CIRCLE_POSITION.INVALID);
});

test('state machine: two outside samples confirm one exit', () => {
  const first = advanceAllowedZoneState(
    { state: ZONE_STATE.INSIDE },
    CIRCLE_POSITION.OUTSIDE,
    1_000,
    { confirmSamples: 2 },
  );
  assert.equal(first.state, ZONE_STATE.EXIT_CANDIDATE);
  assert.equal(first.transition, ZONE_TRANSITION.EXIT_CANDIDATE);

  const second = advanceAllowedZoneState(
    first,
    CIRCLE_POSITION.OUTSIDE,
    11_000,
    { confirmSamples: 2 },
  );
  assert.equal(second.state, ZONE_STATE.OUTSIDE);
  assert.equal(second.transition, ZONE_TRANSITION.EXIT_CONFIRMED);

  const third = advanceAllowedZoneState(
    second,
    CIRCLE_POSITION.OUTSIDE,
    21_000,
    { confirmSamples: 2 },
  );
  assert.equal(third.transition, ZONE_TRANSITION.NONE);
});

test('state machine: uncertainty cancels a possible exit', () => {
  const candidate = advanceAllowedZoneState(
    { state: ZONE_STATE.INSIDE },
    CIRCLE_POSITION.OUTSIDE,
    1_000,
  );
  const result = advanceAllowedZoneState(
    candidate,
    CIRCLE_POSITION.UNCERTAIN,
    2_000,
  );
  assert.equal(result.state, ZONE_STATE.INSIDE);
  assert.equal(result.transition, ZONE_TRANSITION.EXIT_CANCELLED);
});

test('state machine: confirmed re-entry resolves only after confirmation', () => {
  const first = advanceAllowedZoneState(
    { state: ZONE_STATE.OUTSIDE },
    CIRCLE_POSITION.INSIDE,
    1_000,
    { confirmSamples: 2 },
  );
  assert.equal(first.state, ZONE_STATE.ENTRY_CANDIDATE);

  const second = advanceAllowedZoneState(
    first,
    CIRCLE_POSITION.INSIDE,
    2_000,
    { confirmSamples: 2 },
  );
  assert.equal(second.state, ZONE_STATE.INSIDE);
  assert.equal(second.transition, ZONE_TRANSITION.ENTRY_CONFIRMED);
});

test('state machine: confirmation can require both samples and dwell time', () => {
  const first = advanceAllowedZoneState(
    { state: ZONE_STATE.INSIDE },
    CIRCLE_POSITION.OUTSIDE,
    1_000,
    { confirmSamples: 2, confirmSeconds: 10 },
  );
  const tooSoon = advanceAllowedZoneState(
    first,
    CIRCLE_POSITION.OUTSIDE,
    5_000,
    { confirmSamples: 2, confirmSeconds: 10 },
  );
  assert.equal(tooSoon.state, ZONE_STATE.EXIT_CANDIDATE);

  const confirmed = advanceAllowedZoneState(
    tooSoon,
    CIRCLE_POSITION.OUTSIDE,
    11_000,
    { confirmSamples: 2, confirmSeconds: 10 },
  );
  assert.equal(confirmed.transition, ZONE_TRANSITION.EXIT_CONFIRMED);
});
