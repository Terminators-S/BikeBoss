/**
 * Geo math utilities.
 */

export const EARTH_RADIUS_M = 6371000;

export function toRadians(deg) {
  return deg * (Math.PI / 180.0);
}

/**
 * Haversine great-circle distance in meters.
 */
export function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * True only for finite WGS84 coordinates. `0,0` is technically valid and is
 * therefore handled by telemetry validation, where it is rejected as a known
 * device sentinel rather than by this generic geo helper.
 */
export function isValidCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90
    && lon >= -180 && lon <= 180;
}

export const CIRCLE_POSITION = Object.freeze({
  INSIDE: 'INSIDE',
  OUTSIDE: 'OUTSIDE',
  UNCERTAIN: 'UNCERTAIN',
  INVALID: 'INVALID',
});

/**
 * Accuracy-aware circle classification.
 *
 * Horizontal accuracy is interpreted as an uncertainty radius. A sample only
 * counts as outside when its entire uncertainty circle is beyond the exit
 * boundary, and only counts as inside when it is fully within the entry
 * boundary. Everything between those limits is deliberately uncertain.
 */
export function classifyCirclePosition({
  centerLat,
  centerLon,
  radiusM,
  sampleLat,
  sampleLon,
  accuracyM = 0,
  exitBufferM = 0,
  entryBufferM = 0,
}) {
  if (!isValidCoordinate(centerLat, centerLon)
      || !isValidCoordinate(sampleLat, sampleLon)
      || !Number.isFinite(radiusM) || radiusM <= 0
      || !Number.isFinite(accuracyM) || accuracyM < 0
      || !Number.isFinite(exitBufferM) || exitBufferM < 0
      || !Number.isFinite(entryBufferM) || entryBufferM < 0) {
    return { classification: CIRCLE_POSITION.INVALID, distanceM: null };
  }

  const distanceM = haversineDistance(
    centerLat,
    centerLon,
    sampleLat,
    sampleLon,
  );

  if (distanceM - accuracyM > radiusM + exitBufferM) {
    return { classification: CIRCLE_POSITION.OUTSIDE, distanceM };
  }

  const insideBoundaryM = Math.max(0, radiusM - entryBufferM);
  if (distanceM + accuracyM < insideBoundaryM) {
    return { classification: CIRCLE_POSITION.INSIDE, distanceM };
  }

  return { classification: CIRCLE_POSITION.UNCERTAIN, distanceM };
}
