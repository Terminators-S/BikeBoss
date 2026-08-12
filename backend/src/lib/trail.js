import { haversineDistance } from './geo.js';
import { parseDatabaseTimestamp } from './device-status.js';
import { assessGpsSample, gpsSampleFromRow } from './gps-sanity.js';

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RAW_POINTS = 125_000;
export const TRAIL_DETAIL_TOLERANCE_M = 2;

export const TRAIL_PRESETS = Object.freeze({
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': MAX_WINDOW_MS,
});

function iso(value) {
  return new Date(value).toISOString();
}

function sqliteUtc(value) {
  return iso(value).replace('T', ' ').replace(/\.\d{3}Z$/u, '');
}

export function resolveTrailWindow(urlValue, nowMs = Date.now()) {
  const url = urlValue instanceof URL ? urlValue : new URL(urlValue, 'https://bikeboss.invalid');
  const fromValue = url.searchParams.get('from');
  const toValue = url.searchParams.get('to');
  const preset = url.searchParams.get('range') || '1h';

  let fromMs;
  let toMs;
  let range = preset;
  if (fromValue || toValue) {
    if (!fromValue || !toValue) return { ok: false, error: 'trail_window_incomplete' };
    fromMs = Date.parse(fromValue);
    toMs = Date.parse(toValue);
    range = 'custom';
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      return { ok: false, error: 'trail_time_invalid' };
    }
  } else {
    const duration = TRAIL_PRESETS[preset];
    if (!duration) return { ok: false, error: 'trail_range_invalid' };
    toMs = nowMs;
    fromMs = toMs - duration;
  }

  const durationMs = toMs - fromMs;
  if (durationMs <= 0) return { ok: false, error: 'trail_window_invalid' };
  if (durationMs > MAX_WINDOW_MS) return { ok: false, error: 'trail_window_too_large' };
  if (fromMs > nowMs + 60_000) return { ok: false, error: 'trail_window_future' };
  if (toMs > nowMs + 60_000) return { ok: false, error: 'trail_window_future' };

  return {
    ok: true,
    range,
    fromMs,
    toMs,
    fromIso: iso(fromMs),
    toIso: iso(toMs),
    fromSql: sqliteUtc(fromMs),
    toSql: sqliteUtc(toMs),
    bucketSeconds: 0,
    detailToleranceM: TRAIL_DETAIL_TOLERANCE_M,
    gapThresholdSeconds: 90,
    limit: Math.min(MAX_RAW_POINTS + 1, Math.ceil(durationMs / 1_000) + 2),
  };
}

function pointTime(point) {
  return parseDatabaseTimestamp(point?.captured_at ?? point?.received_at);
}

export function buildTrailExperience(rows, gapThresholdSeconds = 90) {
  const points = [];
  let distanceM = 0;
  let gapCount = 0;
  let previous = null;
  let rejectedPointCount = 0;

  for (const row of rows ?? []) {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    const timestamp = pointTime(row);
    const sample = gpsSampleFromRow(row);
    const assessment = assessGpsSample(sample, previous?.sample ?? null);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || timestamp == null
        || !assessment.ok) {
      rejectedPointCount += 1;
      continue;
    }

    let gapBefore = false;
    if (previous) {
      const elapsedSeconds = Math.max(0, (timestamp - previous.timestamp) / 1_000);
      gapBefore = elapsedSeconds > gapThresholdSeconds;
      if (gapBefore) gapCount += 1;
      else distanceM += haversineDistance(previous.lat, previous.lon, lat, lon);
    }

    const point = {
      ...row,
      lat,
      lon,
      gap_before: gapBefore,
    };
    points.push(point);
    previous = { lat, lon, timestamp, sample };
  }

  const firstAt = points[0]?.captured_at ?? points[0]?.received_at ?? null;
  const lastAt = points.at(-1)?.captured_at ?? points.at(-1)?.received_at ?? null;
  const firstMs = pointTime(points[0]);
  const lastMs = pointTime(points.at(-1));
  return {
    points,
    summary: {
      point_count: points.length,
      distance_m: Math.round(distanceM),
      duration_seconds: firstMs == null || lastMs == null
        ? 0 : Math.max(0, Math.round((lastMs - firstMs) / 1_000)),
      gap_count: gapCount,
      rejected_point_count: rejectedPointCount,
      first_at: firstAt,
      last_at: lastAt,
    },
  };
}

function pointSegmentDistanceM(point, start, end) {
  const referenceLatitude = (point.lat + start.lat + end.lat) / 3 * Math.PI / 180;
  const project = (value) => ({
    x: value.lon * Math.PI / 180 * 6_371_000 * Math.cos(referenceLatitude),
    y: value.lat * Math.PI / 180 * 6_371_000,
  });
  const projectedPoint = project(point);
  const projectedStart = project(start);
  const projectedEnd = project(end);
  const dx = projectedEnd.x - projectedStart.x;
  const dy = projectedEnd.y - projectedStart.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(
      projectedPoint.x - projectedStart.x,
      projectedPoint.y - projectedStart.y,
    );
  }
  const ratio = Math.max(0, Math.min(1, (
    (projectedPoint.x - projectedStart.x) * dx
    + (projectedPoint.y - projectedStart.y) * dy
  ) / (dx * dx + dy * dy)));
  return Math.hypot(
    projectedPoint.x - (projectedStart.x + ratio * dx),
    projectedPoint.y - (projectedStart.y + ratio * dy),
  );
}

function simplifySegment(points, toleranceM) {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [startIndex, endIndex] = stack.pop();
    let furthestIndex = -1;
    let furthestDistanceM = toleranceM;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distanceM = pointSegmentDistanceM(
        points[index],
        points[startIndex],
        points[endIndex],
      );
      if (distanceM > furthestDistanceM) {
        furthestDistanceM = distanceM;
        furthestIndex = index;
      }
    }
    if (furthestIndex !== -1) {
      keep[furthestIndex] = 1;
      stack.push([startIndex, furthestIndex], [furthestIndex, endIndex]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

export function simplifyTrailPoints(points, toleranceM = TRAIL_DETAIL_TOLERANCE_M) {
  if (!Array.isArray(points) || points.length <= 2 || toleranceM <= 0) {
    return [...(points ?? [])];
  }
  const simplified = [];
  let segment = [];
  const flush = () => {
    if (segment.length === 0) return;
    simplified.push(...simplifySegment(segment, toleranceM));
    segment = [];
  };
  for (const point of points) {
    if (point.gap_before && segment.length > 0) flush();
    segment.push(point);
  }
  flush();
  return simplified;
}

export function buildDetailedTrailExperience(
  rows,
  gapThresholdSeconds = 90,
  toleranceM = TRAIL_DETAIL_TOLERANCE_M,
) {
  const full = buildTrailExperience(rows, gapThresholdSeconds);
  const points = simplifyTrailPoints(full.points, toleranceM);
  return {
    points,
    summary: {
      ...full.summary,
      point_count: points.length,
      source_point_count: full.points.length,
      detail_tolerance_m: toleranceM,
    },
  };
}
