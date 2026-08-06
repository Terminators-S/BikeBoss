/**
 * Trip reconstruction + scoring persistence.
 */

import { haversineDistance } from './geo.js';
import { scoreTrip } from './imu.js';

const HARD_BRAKE_ATOTAL = -8.0;   // m/s² rapid decel
const HARSH_ACCEL_ATOTAL = 19.6;  // m/s² rapid accel
const TRIP_START_SPEED = 5;       // km/h
const TRIP_GAP_CLOSE_S = 300;     // 5 min silence closes a trip

export async function reconstructTrip(deviceId, env) {
  const recent = await env.DB.prepare(
    `SELECT * FROM telemetry WHERE device_id = ? AND gps_fix = 1
     ORDER BY received_at DESC LIMIT 2`
  ).bind(deviceId).all();

  if (!recent.results || recent.results.length < 2) return;

  const [curr, prev] = recent.results;
  if (curr.gps_speed == null) return;

  const ongoing = await env.DB.prepare(
    `SELECT * FROM trips WHERE device_id = ? AND end_time IS NULL
     ORDER BY start_time DESC LIMIT 1`
  ).bind(deviceId).first();

  const timeDiffS =
    (new Date(curr.received_at + 'Z') - new Date(prev.received_at + 'Z')) / 1000;

  if (ongoing) {
    if (timeDiffS > TRIP_GAP_CLOSE_S) {
      // Close trip
      const durationH = Math.max(
        (new Date(curr.received_at + 'Z') - new Date(ongoing.start_time + 'Z')) / 3600000,
        0.0001
      );
      const avgSpeed = ongoing.distance_km / durationH;
      await env.DB.prepare(
        `UPDATE trips SET end_time = ?, avg_speed_kmh = ? WHERE id = ?`
      ).bind(curr.received_at, avgSpeed, ongoing.id).run();

      await computeTripScores(ongoing.id, deviceId, env);
      return;
    }

    if (curr.gps_speed > 0 && prev.gps_lat != null && curr.gps_lat != null) {
      const segmentDist = haversineDistance(
        prev.gps_lat, prev.gps_lon, curr.gps_lat, curr.gps_lon
      );
      await env.DB.prepare(
        `UPDATE trips SET
           end_lat = ?, end_lon = ?,
           distance_km = distance_km + ?,
           max_speed_kmh = MAX(max_speed_kmh, ?),
           hard_brakes = hard_brakes + ?,
           harsh_accels = harsh_accels + ?
         WHERE id = ?`
      ).bind(
        curr.gps_lat,
        curr.gps_lon,
        segmentDist / 1000,
        curr.gps_speed,
        (curr.imu_atotal ?? 0) < HARD_BRAKE_ATOTAL ? 1 : 0,
        (curr.imu_atotal ?? 0) > HARSH_ACCEL_ATOTAL ? 1 : 0,
        ongoing.id
      ).run();
    }
  } else if (curr.gps_speed > TRIP_START_SPEED) {
    await env.DB.prepare(
      `INSERT INTO trips (device_id, start_time, start_lat, start_lon, end_lat, end_lon, max_speed_kmh)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      deviceId,
      curr.received_at,
      curr.gps_lat,
      curr.gps_lon,
      curr.gps_lat,
      curr.gps_lon,
      curr.gps_speed
    ).run();
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
    `UPDATE trips SET safety_score = ?, eco_score = ? WHERE id = ?`
  ).bind(safety, eco, tripId).run();

  const features = JSON.stringify({
    hard_brakes: trip.hard_brakes,
    harsh_accels: trip.harsh_accels,
    max_speed_kmh: trip.max_speed_kmh,
    distance_km: trip.distance_km,
  });

  await env.DB.prepare(
    `INSERT INTO scoring_logs (device_id, trip_id, score_type, score_value, model_version, input_features)
     VALUES (?, ?, 'safety', ?, 'heuristic-v1', ?)`
  ).bind(deviceId, tripId, safety, features).run();

  await env.DB.prepare(
    `INSERT INTO scoring_logs (device_id, trip_id, score_type, score_value, model_version, input_features)
     VALUES (?, ?, 'eco', ?, 'heuristic-v1', ?)`
  ).bind(deviceId, tripId, eco, features).run();
}
