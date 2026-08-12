import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDetailedTrailExperience,
  buildTrailExperience,
  resolveTrailWindow,
  simplifyTrailPoints,
} from '../src/lib/trail.js';

const NOW = Date.parse('2026-08-09T06:00:00Z');

test('trail presets use the same raw geometry detail for every range', () => {
  const oneHour = resolveTrailWindow('https://api.example/trail?range=1h', NOW);
  assert.equal(oneHour.ok, true);
  assert.equal(oneHour.fromIso, '2026-08-09T05:00:00.000Z');
  assert.equal(oneHour.toIso, '2026-08-09T06:00:00.000Z');
  assert.equal(oneHour.bucketSeconds, 0);
  assert.equal(oneHour.detailToleranceM, 2);
  assert.equal(oneHour.gapThresholdSeconds, 90);
  assert.equal(oneHour.limit, 3_602);

  const sixHours = resolveTrailWindow('https://api.example/trail?range=6h', NOW);
  assert.equal(sixHours.ok, true);
  assert.equal(sixHours.bucketSeconds, 0);
  assert.equal(sixHours.detailToleranceM, 2);
  assert.equal(sixHours.limit, 21_602);

  const oneDay = resolveTrailWindow('https://api.example/trail?range=24h', NOW);
  assert.equal(oneDay.ok, true);
  assert.equal(oneDay.bucketSeconds, 0);
  assert.equal(oneDay.detailToleranceM, 2);
  assert.equal(oneDay.limit, 86_402);

  const week = resolveTrailWindow('https://api.example/trail?range=7d', NOW);
  assert.equal(week.ok, true);
  assert.equal(week.bucketSeconds, 0);
  assert.equal(week.detailToleranceM, 2);
  assert.equal(week.limit, 125_001);
});

test('geometry simplification removes straight-line noise but preserves road turns and gaps', () => {
  const points = [
    { lat: 11.55, lon: 104.91, gap_before: false },
    { lat: 11.55005, lon: 104.91, gap_before: false },
    { lat: 11.5501, lon: 104.91, gap_before: false },
    { lat: 11.5501, lon: 104.9101, gap_before: false },
    { lat: 11.56, lon: 104.92, gap_before: true },
    { lat: 11.5601, lon: 104.9201, gap_before: false },
  ];
  const simplified = simplifyTrailPoints(points, 2);
  assert.ok(simplified.includes(points[2]), 'the right-angle turn remains visible');
  assert.ok(!simplified.includes(points[1]), 'the redundant straight point is removed');
  assert.ok(simplified.includes(points[4]), 'the first point after a data gap is preserved');
});

test('detailed trail summary reports source and displayed point counts', () => {
  const result = buildDetailedTrailExperience([
    { lat: 11.55, lon: 104.91, captured_at: '2026-08-09T05:00:00Z' },
    { lat: 11.55005, lon: 104.91, captured_at: '2026-08-09T05:00:10Z' },
    { lat: 11.5501, lon: 104.91, captured_at: '2026-08-09T05:00:20Z' },
  ], 90, 2);
  assert.equal(result.summary.source_point_count, 3);
  assert.equal(result.summary.point_count, 2);
  assert.equal(result.summary.detail_tolerance_m, 2);
});

test('custom trail windows reject incomplete, reversed, and overlong ranges', () => {
  assert.equal(resolveTrailWindow('https://api.example/trail?from=2026-08-09T00:00:00Z', NOW).error, 'trail_window_incomplete');
  assert.equal(resolveTrailWindow('https://api.example/trail?from=2026-08-09T05:00:00Z&to=2026-08-09T04:00:00Z', NOW).error, 'trail_window_invalid');
  assert.equal(resolveTrailWindow('https://api.example/trail?range=30d', NOW).error, 'trail_range_invalid');
});

test('trail experience marks connection gaps and excludes them from route distance', () => {
  const result = buildTrailExperience([
    { lat: 11.55, lon: 104.91, captured_at: '2026-08-09T05:00:00Z' },
    { lat: 11.5501, lon: 104.9101, captured_at: '2026-08-09T05:00:10Z' },
    { lat: 11.56, lon: 104.92, captured_at: '2026-08-09T05:05:00Z' },
  ], 90);

  assert.equal(result.points.length, 3);
  assert.equal(result.points[1].gap_before, false);
  assert.equal(result.points[2].gap_before, true);
  assert.equal(result.summary.gap_count, 1);
  assert.ok(result.summary.distance_m > 0 && result.summary.distance_m < 50);
});

test('trail experience removes impossible GPS teleports without poisoning the next point', () => {
  const result = buildTrailExperience([
    { lat: 11.641214, lon: 104.919744, gps_hdop: 0.6, captured_at: '2026-08-11T05:44:38Z' },
    { lat: 11.638262, lon: 102.650003, gps_hdop: 0.6, captured_at: '2026-08-11T05:44:43Z' },
    { lat: 11.641219, lon: 104.919776, gps_hdop: 0.6, captured_at: '2026-08-11T05:44:48Z' },
  ]);
  assert.equal(result.points.length, 2);
  assert.equal(result.summary.rejected_point_count, 1);
  assert.ok(result.summary.distance_m < 10);
});
