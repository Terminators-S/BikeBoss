/**
 * Automatic trip lifecycle, route ownership, and scoring persistence.
 */

import { haversineDistance, isValidCoordinate } from './geo.js';
import { scoreTrip } from './imu.js';
import { parseDatabaseTimestamp } from './device-status.js';

export const TRIP_RULES = Object.freeze({
  startSpeedKmh: 3,
  stationaryDwellSeconds: 180,
  telemetryGapSeconds: 300,
  hardBrakeMps2: 3,
  harshAccelerationMps2: 3,
  maximumPlausibleSegmentKmh: 220,
});

function telemetryTime(sample) {
  return sample?.captured_at ?? sample?.received_at ?? null;
}

function telemetryTimeMs(sample) {
  return parseDatabaseTimestamp(telemetryTime(sample));
}

function normalizeTripSample(body, telemetryId = null) {
  const gps = body?.gps ?? null;
  const lat = Number(gps ? gps.lat : body?.gps_lat);
  const lon = Number(gps ? gps.lon : body?.gps_lon);
  const speed = Number(gps ? gps.speed : body?.gps_speed);
  const fix = gps ? Boolean(gps.fix) : Boolean(body?.gps_fix);
  const candidateId = telemetryId ?? body?.id;
  return {
    id: candidateId != null && Number.isFinite(Number(candidateId)) && Number(candidateId) > 0
      ? Number(candidateId)
      : null,
    device_id: body?.device_id,
    message_id: body?.message_id ?? null,
    sequence: body?.sequence ?? null,
    gps_fix: fix ? 1 : 0,
    gps_lat: lat,
    gps_lon: lon,
    gps_speed: Number.isFinite(speed) ? Math.max(0, speed) : 0,
    motion_state: body?.motion_state ?? null,
    imu_atotal: Number(body?.imu?.atotal ?? body?.imu_atotal ?? 0),
    captured_at: body?.captured_at ?? null,
    received_at: body?.received_at ?? null,
  };
}

export function isTripMovement(sample) {
  return String(sample?.motion_state ?? '').toLowerCase() === 'moving'
    || Number(sample?.gps_speed ?? 0) >= TRIP_RULES.startSpeedKmh;
}

export function decideTripAction({ ongoing, previous, sample }) {
  const sampleMs = telemetryTimeMs(sample);
  if (!sample?.device_id || sampleMs == null
      || !sample.gps_fix
      || !isValidCoordinate(Number(sample.gps_lat), Number(sample.gps_lon))
      || (Number(sample.gps_lat) === 0 && Number(sample.gps_lon) === 0)) {
    return { type: 'ignore' };
  }

  const moving = isTripMovement(sample);
  if (!ongoing) return { type: moving ? 'start' : 'ignore', moving };

  const previousMs = telemetryTimeMs(previous);
  const gapAnchorMs = previousMs
    ?? parseDatabaseTimestamp(ongoing.stationary_since ?? ongoing.last_moving_at ?? ongoing.start_time);
  if (gapAnchorMs != null
      && sampleMs - gapAnchorMs > TRIP_RULES.telemetryGapSeconds * 1_000) {
    return {
      type: moving ? 'close_then_start' : 'close',
      moving,
      endAt: ongoing.stationary_since
        ?? ongoing.last_moving_at
        ?? telemetryTime(previous)
        ?? ongoing.start_time,
    };
  }

  const stationarySinceMs = parseDatabaseTimestamp(ongoing.stationary_since);
  if (!moving && stationarySinceMs != null
      && sampleMs - stationarySinceMs >= TRIP_RULES.stationaryDwellSeconds * 1_000) {
    return {
      type: 'close',
      moving,
      endAt: ongoing.stationary_since,
    };
  }

  return { type: 'continue', moving };
}

function insertId(result) {
  const value = Number(result?.meta?.last_row_id);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function resolveTelemetryId(sample, env) {
  if (sample.id != null) return sample.id;
  if (sample.message_id == null && sample.sequence == null) return null;
  const row = await env.DB.prepare(
    `SELECT id FROM telemetry
     WHERE device_id = ?
       AND ((? IS NOT NULL AND message_id = ?)
         OR (? IS NOT NULL AND sequence = ?))
     ORDER BY id DESC LIMIT 1`
  ).bind(
    sample.device_id,
    sample.message_id,
    sample.message_id,
    sample.sequence,
    sample.sequence,
  ).first();
  return row?.id == null ? null : Number(row.id);
}

async function openTrip(deviceId, env) {
  return env.DB.prepare(
    `SELECT * FROM trips
     WHERE device_id = ? AND end_time IS NULL
     ORDER BY start_time DESC, id DESC LIMIT 1`
  ).bind(deviceId).first();
}

async function previousTripSample(tripId, env) {
  return env.DB.prepare(
    `SELECT id, device_id, gps_lat, gps_lon, gps_speed, gps_fix,
            motion_state, imu_atotal, captured_at, received_at
     FROM telemetry
     WHERE trip_id = ?
     ORDER BY datetime(COALESCE(captured_at, received_at)) DESC, id DESC
     LIMIT 1`
  ).bind(tripId).first();
}

function segmentMetrics(previous, sample) {
  const previousMs = telemetryTimeMs(previous);
  const sampleMs = telemetryTimeMs(sample);
  const elapsedSeconds = previousMs == null || sampleMs == null
    ? 0
    : (sampleMs - previousMs) / 1_000;
  if (!previous || elapsedSeconds <= 0
      || elapsedSeconds > TRIP_RULES.telemetryGapSeconds
      || !isValidCoordinate(Number(previous.gps_lat), Number(previous.gps_lon))) {
    return { distanceKm: 0, hardBrakes: 0, harshAccels: 0 };
  }

  const movementPresent = isTripMovement(previous) || isTripMovement(sample);
  let distanceM = movementPresent
    ? haversineDistance(
      Number(previous.gps_lat),
      Number(previous.gps_lon),
      Number(sample.gps_lat),
      Number(sample.gps_lon),
    )
    : 0;
  const impliedSpeedKmh = distanceM / elapsedSeconds * 3.6;
  const reportedSpeedKmh = Math.max(
    Number(previous.gps_speed ?? 0),
    Number(sample.gps_speed ?? 0),
  );
  if (impliedSpeedKmh > Math.max(
    TRIP_RULES.maximumPlausibleSegmentKmh,
    reportedSpeedKmh + 100,
  )) {
    distanceM = 0;
  }

  const accelerationMps2 = (
    Number(sample.gps_speed ?? 0) - Number(previous.gps_speed ?? 0)
  ) / 3.6 / elapsedSeconds;
  return {
    distanceKm: distanceM / 1_000,
    hardBrakes: accelerationMps2 <= -TRIP_RULES.hardBrakeMps2 ? 1 : 0,
    harshAccels: accelerationMps2 >= TRIP_RULES.harshAccelerationMps2 ? 1 : 0,
  };
}

async function startTrip(sample, env) {
  const result = await env.DB.prepare(
    `INSERT INTO trips (
       device_id, start_time, start_lat, start_lon, end_lat, end_lon,
       max_speed_kmh, last_moving_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    sample.device_id,
    telemetryTime(sample),
    sample.gps_lat,
    sample.gps_lon,
    sample.gps_lat,
    sample.gps_lon,
    sample.gps_speed,
    telemetryTime(sample),
  ).run();
  const tripId = insertId(result) ?? (await openTrip(sample.device_id, env))?.id;
  if (tripId == null || sample.id == null) return tripId;
  await env.DB.prepare(
    'UPDATE telemetry SET trip_id = ? WHERE id = ? AND trip_id IS NULL'
  ).bind(tripId, sample.id).run();
  return tripId;
}

async function continueTrip(ongoing, previous, sample, moving, env) {
  if (sample.id == null) return;
  const metrics = segmentMetrics(previous, sample);
  const sampleMs = telemetryTimeMs(sample);
  const startMs = parseDatabaseTimestamp(ongoing.start_time);
  const durationHours = Math.max(
    startMs == null || sampleMs == null ? 0 : (sampleMs - startMs) / 3_600_000,
    1 / 3_600,
  );
  const statements = [
    env.DB.prepare(
      `UPDATE trips SET
         end_lat = ?, end_lon = ?,
         distance_km = distance_km + ?,
         max_speed_kmh = MAX(max_speed_kmh, ?),
         avg_speed_kmh = (distance_km + ?) / ?,
         hard_brakes = hard_brakes + ?,
         harsh_accels = harsh_accels + ?,
         last_moving_at = CASE WHEN ? = 1 THEN ? ELSE last_moving_at END,
         stationary_since = CASE
           WHEN ? = 1 THEN NULL
           ELSE COALESCE(stationary_since, ?)
         END
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM telemetry WHERE id = ? AND trip_id IS NULL
         )`
    ).bind(
      sample.gps_lat,
      sample.gps_lon,
      metrics.distanceKm,
      sample.gps_speed,
      metrics.distanceKm,
      durationHours,
      metrics.hardBrakes,
      metrics.harshAccels,
      moving ? 1 : 0,
      telemetryTime(sample),
      moving ? 1 : 0,
      telemetryTime(sample),
      ongoing.id,
      sample.id,
    ),
    env.DB.prepare(
      'UPDATE telemetry SET trip_id = ? WHERE id = ? AND trip_id IS NULL'
    ).bind(ongoing.id, sample.id),
  ];
  await env.DB.batch(statements);
}

async function closeTrip(ongoing, endAt, env) {
  const endTime = endAt ?? ongoing.last_moving_at ?? ongoing.start_time;
  const endpoint = await env.DB.prepare(
    `SELECT gps_lat, gps_lon
     FROM telemetry
     WHERE trip_id = ?
       AND datetime(COALESCE(captured_at, received_at)) <= datetime(?)
     ORDER BY datetime(COALESCE(captured_at, received_at)) DESC, id DESC
     LIMIT 1`
  ).bind(ongoing.id, endTime).first();
  const startMs = parseDatabaseTimestamp(ongoing.start_time);
  const endMs = parseDatabaseTimestamp(endTime);
  const durationHours = Math.max(
    startMs == null || endMs == null ? 0 : (endMs - startMs) / 3_600_000,
    1 / 3_600,
  );
  const averageSpeed = Number(ongoing.distance_km ?? 0) / durationHours;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE trips SET
         end_time = ?, end_lat = COALESCE(?, end_lat),
         end_lon = COALESCE(?, end_lon), avg_speed_kmh = ?,
         stationary_since = NULL
       WHERE id = ? AND end_time IS NULL`
    ).bind(
      endTime,
      endpoint?.gps_lat ?? null,
      endpoint?.gps_lon ?? null,
      averageSpeed,
      ongoing.id,
    ),
    env.DB.prepare(
      `UPDATE telemetry SET trip_id = NULL
       WHERE trip_id = ?
         AND datetime(COALESCE(captured_at, received_at)) > datetime(?)`
    ).bind(ongoing.id, endTime),
  ]);
  await computeTripScores(ongoing.id, ongoing.device_id, env);
}

/**
 * Process one already-durable telemetry row. Batch callers must invoke this in
 * captured-time order so replayed points remain attached to the correct trip.
 */
export async function processTripTelemetry(body, telemetryId, env) {
  const sample = normalizeTripSample(body, telemetryId);
  if (!sample.device_id || !sample.gps_fix) return;
  sample.id = await resolveTelemetryId(sample, env);
  if (sample.id == null) return;

  const assignment = await env.DB.prepare(
    'SELECT trip_id FROM telemetry WHERE id = ?'
  ).bind(sample.id).first();
  if (assignment?.trip_id != null) return;

  let ongoing = await openTrip(sample.device_id, env);
  let previous = ongoing ? await previousTripSample(ongoing.id, env) : null;
  const decision = decideTripAction({ ongoing, previous, sample });

  if (decision.type === 'ignore') return;
  if (decision.type === 'close' || decision.type === 'close_then_start') {
    await closeTrip(ongoing, decision.endAt, env);
    ongoing = null;
    previous = null;
    if (decision.type === 'close') return;
  }

  if (decision.type === 'start' || decision.type === 'close_then_start') {
    try {
      await startTrip(sample, env);
      return;
    } catch (error) {
      if (!String(error?.message ?? error).includes('UNIQUE constraint failed')) throw error;
      ongoing = await openTrip(sample.device_id, env);
      previous = ongoing ? await previousTripSample(ongoing.id, env) : null;
    }
  }

  if (ongoing) {
    await continueTrip(ongoing, previous, sample, isTripMovement(sample), env);
  }
}

export async function computeTripScores(tripId, deviceId, env) {
  const trip = await env.DB.prepare(
    'SELECT * FROM trips WHERE id = ?'
  ).bind(tripId).first();
  if (!trip) return;

  const { safety, eco } = scoreTrip({
    hardBrakes: trip.hard_brakes,
    harshAccels: trip.harsh_accels,
    maxSpeedKmh: trip.max_speed_kmh,
  });

  await env.DB.prepare(
    'UPDATE trips SET safety_score = ?, eco_score = ? WHERE id = ?'
  ).bind(safety, eco, tripId).run();

  const features = JSON.stringify({
    hard_brakes: trip.hard_brakes,
    harsh_accels: trip.harsh_accels,
    max_speed_kmh: trip.max_speed_kmh,
    avg_speed_kmh: trip.avg_speed_kmh,
    distance_km: trip.distance_km,
  });

  await env.DB.prepare(
    `INSERT INTO scoring_logs (
       device_id, trip_id, score_type, score_value, model_version, input_features
     ) VALUES (?, ?, 'safety', ?, 'heuristic-v2', ?)`
  ).bind(deviceId, tripId, safety, features).run();

  await env.DB.prepare(
    `INSERT INTO scoring_logs (
       device_id, trip_id, score_type, score_value, model_version, input_features
     ) VALUES (?, ?, 'eco', ?, 'heuristic-v2', ?)`
  ).bind(deviceId, tripId, eco, features).run();
}
