import { haversineDistance, isValidCoordinate } from './geo.js';
import { parseDatabaseTimestamp } from './device-status.js';

// Phnom Penh road traffic cannot move a motorcycle anywhere near this fast.
// The generous ceiling and fixed slack tolerate sparse samples and ordinary
// GNSS noise while rejecting corrupted NMEA frames and impossible teleports.
export const GPS_MAX_HDOP = 20;
export const GPS_MAX_TRAVEL_SPEED_M_S = 80;
export const GPS_JUMP_SLACK_M = 300;
export const GPS_STATIONARY_HISTORY_SIZE = 8;
export const GPS_STATIONARY_MAX_SPEED_KMH = 2;

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function gpsSampleFromTelemetry(body) {
  const gps = body?.gps;
  if (!gps?.fix) return null;
  return {
    lat: finiteOrNull(gps.lat),
    lon: finiteOrNull(gps.lon),
    accuracyM: finiteOrNull(gps.accuracy_m),
    hdop: finiteOrNull(gps.hdop),
    satellites: finiteOrNull(gps.satellites),
    speedKmh: finiteOrNull(gps.speed),
    motionState: body.motion_state ?? null,
    sampledAt: body.captured_at ?? body.received_at ?? null,
  };
}

export function gpsSampleFromRow(row) {
  if (!row) return null;
  return {
    lat: finiteOrNull(row.lat ?? row.gps_lat),
    lon: finiteOrNull(row.lon ?? row.gps_lon),
    accuracyM: finiteOrNull(row.accuracy_m ?? row.gps_accuracy_m),
    hdop: finiteOrNull(row.hdop ?? row.gps_hdop),
    satellites: finiteOrNull(row.satellites ?? row.gps_satellites),
    speedKmh: finiteOrNull(row.speed_kmh ?? row.gps_speed),
    motionState: row.motion_state ?? null,
    sampledAt: row.captured_at ?? row.received_at ?? null,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function qualityBand(value, bands, missing = 0.5) {
  if (value == null) return missing;
  for (const [limit, score] of bands) {
    if (value <= limit) return score;
  }
  return 0;
}

export function gpsConfidence(sample) {
  if (!sample || !isValidCoordinate(sample.lat, sample.lon)) return 0;
  const accuracyScore = qualityBand(sample.accuracyM, [
    [10, 1], [25, 0.8], [50, 0.55], [100, 0.25], [1_000, 0.05],
  ]);
  const hdopScore = qualityBand(sample.hdop, [
    [1.5, 1], [3, 0.8], [6, 0.55], [10, 0.3], [GPS_MAX_HDOP, 0.05],
  ]);
  const satellites = sample.satellites;
  const satelliteScore = satellites == null ? 0.5
    : satellites >= 10 ? 1
      : satellites >= 7 ? 0.8
        : satellites >= 5 ? 0.55
          : satellites >= 3 ? 0.25 : 0;
  return Number((accuracyScore * 0.45 + hdopScore * 0.35 + satelliteScore * 0.2).toFixed(3));
}

export function robustGpsAnchor(samples = []) {
  const valid = samples.filter((sample) => sample
    && isValidCoordinate(sample.lat, sample.lon)
    && !(sample.lat === 0 && sample.lon === 0));
  if (valid.length < 3) return null;
  const lat = median(valid.map((sample) => sample.lat));
  const lon = median(valid.map((sample) => sample.lon));
  const distances = valid.map((sample) => haversineDistance(lat, lon, sample.lat, sample.lon));
  return {
    lat,
    lon,
    accuracyM: median(valid.map((sample) => sample.accuracyM ?? 15)),
    spreadM: median(distances) ?? 0,
    sampleCount: valid.length,
  };
}

function isStationarySample(sample) {
  return sample?.motionState === 'stationary'
    && Number(sample.speedKmh ?? 0) <= GPS_STATIONARY_MAX_SPEED_KMH;
}

export function assessGpsSample(sample, previous = null, {
  stationaryHistory = [],
} = {}) {
  if (!sample || !isValidCoordinate(sample.lat, sample.lon)
      || (sample.lat === 0 && sample.lon === 0)) {
    return { ok: false, reason: 'coordinate_invalid', confidence: 0 };
  }
  if (sample.accuracyM != null && (sample.accuracyM < 0 || sample.accuracyM > 1_000)) {
    return { ok: false, reason: 'accuracy_invalid', confidence: 0 };
  }
  if (sample.hdop != null && (sample.hdop <= 0 || sample.hdop > GPS_MAX_HDOP)) {
    return { ok: false, reason: 'hdop_unusable', confidence: gpsConfidence(sample) };
  }
  const confidence = gpsConfidence(sample);

  if (isStationarySample(sample)) {
    const sampleAtMs = parseDatabaseTimestamp(sample.sampledAt);
    const relevantHistory = stationaryHistory.filter((entry) => {
      if (!isStationarySample(entry)) return false;
      const entryAtMs = parseDatabaseTimestamp(entry.sampledAt);
      if (sampleAtMs == null || entryAtMs == null) return true;
      return entryAtMs <= sampleAtMs && sampleAtMs - entryAtMs <= 10 * 60 * 1_000;
    });
    const anchor = robustGpsAnchor(relevantHistory);
    if (anchor) {
      const distanceFromAnchorM = haversineDistance(
        anchor.lat, anchor.lon, sample.lat, sample.lon,
      );
      const stationaryRadiusM = Math.min(120, Math.max(
        35,
        anchor.spreadM * 3 + anchor.accuracyM + (sample.accuracyM ?? 15) + 10,
      ));
      if (distanceFromAnchorM > stationaryRadiusM) {
        return {
          ok: false,
          reason: 'stationary_drift',
          confidence,
          distanceM: distanceFromAnchorM,
          allowedDistanceM: stationaryRadiusM,
          anchorSampleCount: anchor.sampleCount,
        };
      }
    }
  }

  if (!previous || !isValidCoordinate(previous.lat, previous.lon)) {
    return { ok: true, reason: null, confidence };
  }

  const sampledAtMs = parseDatabaseTimestamp(sample.sampledAt);
  const previousAtMs = parseDatabaseTimestamp(previous.sampledAt);
  if (sampledAtMs == null || previousAtMs == null) {
    return { ok: true, reason: null, confidence };
  }

  const elapsedSeconds = Math.max(1, (sampledAtMs - previousAtMs) / 1_000);
  const distanceM = haversineDistance(previous.lat, previous.lon, sample.lat, sample.lon);
  const allowedDistanceM = GPS_JUMP_SLACK_M
    + GPS_MAX_TRAVEL_SPEED_M_S * elapsedSeconds
    + Math.max(0, sample.accuracyM ?? 15)
    + Math.max(0, previous.accuracyM ?? 15);
  if (distanceM > allowedDistanceM) {
    return {
      ok: false,
      reason: 'impossible_jump',
      distanceM,
      allowedDistanceM,
      elapsedSeconds,
      confidence,
    };
  }
  return {
    ok: true, reason: null, distanceM, allowedDistanceM, elapsedSeconds, confidence,
  };
}
