/**
 * Accuracy-aware geofence engine plus motion-signal-loss and heartbeat checks.
 */

import {
  CIRCLE_POSITION,
  classifyCirclePosition,
  isValidCoordinate,
} from './geo.js';
import {
  ZONE_STATE,
  ZONE_TRANSITION,
  advanceAllowedZoneState,
} from './geofence-state.js';
import { sendTelegramMessage } from './telegram.js';
import { logEvent, getUserChatIdForDevice, recentEventExists } from './db.js';
import { MOTION_THRESHOLD } from './imu.js';
import { getBotStrings, getLanguageForDevice } from './i18n.js';

export const GEOFENCE_DEFAULT_RADIUS_M = 100;
export const GEOFENCE_DEFAULT_ACCURACY_M = 15;
const STANDARD_GRAVITY_MS2 = 9.80665;
const OWNER_PRESENCE_MAX_AGE_S = 30;
const OWNER_PRESENCE_MIN_CONFIDENCE = 0.7;

export function isTrustedOwnerPresence(ownerPresence) {
  return ownerPresence?.authenticated === true
    && ownerPresence?.connected === true
    && Number(ownerPresence.age_seconds) <= OWNER_PRESENCE_MAX_AGE_S
    && Number(ownerPresence.confidence) >= OWNER_PRESENCE_MIN_CONFIDENCE;
}

function asFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseSampleTime(capturedAt) {
  if (typeof capturedAt === 'string') {
    const parsed = Date.parse(capturedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function stateFromRow(row) {
  if (!row?.state || Number(row.state_zone_version) !== Number(row.version)) {
    return {
      state: ZONE_STATE.UNKNOWN,
      candidateCount: 0,
      candidateSinceMs: null,
      lifecycleId: null,
    };
  }

  const candidateSinceMs = row.candidate_since
    ? Date.parse(`${row.candidate_since.replace(' ', 'T')}Z`)
    : null;

  return {
    state: row.state,
    candidateCount: Number(row.candidate_count ?? 0),
    candidateSinceMs: Number.isFinite(candidateSinceMs) ? candidateSinceMs : null,
    lifecycleId: row.lifecycle_id ?? null,
  };
}

export function formatDistance(distanceM) {
  if (!Number.isFinite(distanceM)) return '—';
  return distanceM < 10 ? distanceM.toFixed(1) : distanceM.toFixed(0);
}

async function persistZoneState(deviceId, zone, next, evidence, lifecycleId, env) {
  const candidateSince = next.candidateSinceMs == null
    ? null
    : new Date(next.candidateSinceMs).toISOString();
  const transitionAt = next.transition ? evidence.capturedAt : null;

  await env.DB.prepare(
    `INSERT INTO device_zone_state (
       device_id, zone_id, zone_version, state, candidate_count,
       candidate_since, lifecycle_id, last_distance_m, last_accuracy_m,
       last_classification, last_sample_at, last_transition_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(device_id, zone_id) DO UPDATE SET
       zone_version = excluded.zone_version,
       state = excluded.state,
       candidate_count = excluded.candidate_count,
       candidate_since = excluded.candidate_since,
       lifecycle_id = excluded.lifecycle_id,
       last_distance_m = excluded.last_distance_m,
       last_accuracy_m = excluded.last_accuracy_m,
       last_classification = excluded.last_classification,
       last_sample_at = excluded.last_sample_at,
       last_transition_at = COALESCE(excluded.last_transition_at, device_zone_state.last_transition_at),
       updated_at = datetime('now')`
  ).bind(
    deviceId,
    zone.id,
    zone.version,
    next.state,
    next.candidateCount,
    candidateSince,
    lifecycleId,
    evidence.distanceM,
    evidence.accuracyM,
    evidence.classification,
    evidence.capturedAt,
    transitionAt,
  ).run();
}

async function recordGeofenceTransition({
  deviceId,
  zone,
  previousState,
  next,
  lifecycleId,
  sample,
  evidence,
  alertSuppressed,
  suppressionReason,
}, env) {
  if (!next.transition || next.transition === ZONE_TRANSITION.INITIALIZED_INSIDE) {
    return null;
  }

  const eventUuid = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO geofence_events (
       event_uuid, lifecycle_id, device_id, zone_id, zone_version,
       transition, state_from, state_to, gps_lat, gps_lon,
       distance_m, accuracy_m, evidence_json, occurred_at,
       alert_suppressed, suppression_reason, owner_presence_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    eventUuid,
    lifecycleId,
    deviceId,
    zone.id,
    zone.version,
    next.transition,
    previousState,
    next.state,
    sample.lat,
    sample.lon,
    evidence.distanceM,
    evidence.accuracyM,
    JSON.stringify({
      classification: evidence.classification,
      radius_m: zone.radius_m,
      exit_buffer_m: zone.exit_buffer_m,
      entry_buffer_m: zone.entry_buffer_m,
      confirm_samples: zone.confirm_samples,
      confirm_seconds: zone.confirm_seconds,
      gps_accuracy_limit_m: zone.gps_accuracy_limit_m,
      speed_kmh: sample.speedKmh,
      message_id: sample.messageId ?? null,
      rule_version: 'circle-v2.0.0',
      owner_presence: sample.ownerPresence ?? null,
    }),
    evidence.capturedAt,
    alertSuppressed ? 1 : 0,
    suppressionReason ?? null,
    sample.ownerPresence ? JSON.stringify(sample.ownerPresence) : null,
  ).run();

  return eventUuid;
}

async function notifyExit(deviceId, zone, sample, evidence, lifecycleId, env) {
  const eventId = await logEvent(deviceId, 'GEOFENCE_BREACH', 'warning', env, {
    lat: sample.lat,
    lon: sample.lon,
    payload: {
      lifecycle_id: lifecycleId,
      zone_id: zone.id,
      zone_uuid: zone.zone_uuid,
      zone_version: zone.version,
      zone_label: zone.label,
      distance_m: evidence.distanceM,
      accuracy_m: evidence.accuracyM,
      radius_m: zone.radius_m,
      speed_kmh: sample.speedKmh,
      rule_version: 'circle-v2.0.0',
    },
  });

  const chatId = await getUserChatIdForDevice(deviceId, env);
  if (!chatId) return;

  const strings = getBotStrings(await getLanguageForDevice(deviceId, env));
  await sendTelegramMessage(chatId, strings.geofenceBreach({
    deviceId,
    zone: zone.label,
    distance: formatDistance(evidence.distanceM),
    radius: zone.radius_m,
    speed: asFiniteNumber(sample.speedKmh, 0).toFixed(1),
    accuracy: formatDistance(evidence.accuracyM),
    locationLink: `📍 <a href="https://maps.google.com/?q=${sample.lat},${sample.lon}">View on Map</a>`,
  }), env, { deviceId, eventId });
}

async function notifyResolved(deviceId, zone, sample, lifecycleId, env) {
  const eventId = await logEvent(deviceId, 'GEOFENCE_REENTRY', 'info', env, {
    lat: sample.lat,
    lon: sample.lon,
    payload: {
      lifecycle_id: lifecycleId,
      zone_id: zone.id,
      zone_uuid: zone.zone_uuid,
      zone_version: zone.version,
      zone_label: zone.label,
    },
  });

  const chatId = await getUserChatIdForDevice(deviceId, env);
  if (!chatId) return;
  const strings = getBotStrings(await getLanguageForDevice(deviceId, env));
  if (!strings.geofenceResolved) return;

  await sendTelegramMessage(chatId, strings.geofenceResolved({
    deviceId,
    zone: zone.label,
  }), env, { deviceId, eventId });
}

/**
 * Evaluate every active safe circle assigned to a device. A result is returned
 * for every zone, so overlapping zones cannot intercept one another.
 */
export async function checkGeofence(deviceId, sample, env) {
  if (!sample?.fix || !isValidCoordinate(sample.lat, sample.lon)
      || (sample.lat === 0 && sample.lon === 0)) {
    return [];
  }

  const zones = await env.DB.prepare(
    `SELECT z.*,
            s.zone_version AS state_zone_version,
            s.state, s.candidate_count, s.candidate_since, s.lifecycle_id
     FROM geofence_zones z
     LEFT JOIN device_zone_state s
       ON s.device_id = z.device_id AND s.zone_id = z.id
     WHERE z.device_id = ?
       AND z.is_active = 1
       AND z.status = 'active'
       AND z.zone_type = 'circle'
       AND z.policy_type = 'safe'
     ORDER BY z.id`
  ).bind(deviceId).all();

  if (!zones.results?.length) return [];

  const capturedAtMs = parseSampleTime(sample.capturedAt);
  const capturedAt = new Date(capturedAtMs).toISOString();
  const configuredDefaultAccuracy = asFiniteNumber(
    env.GEOFENCE_DEFAULT_ACCURACY_M,
    GEOFENCE_DEFAULT_ACCURACY_M,
  );
  const reportedAccuracy = asFiniteNumber(sample.accuracyM, configuredDefaultAccuracy);
  const ownerPresence = sample.ownerPresence;
  const trustedOwnerPresent = isTrustedOwnerPresence(ownerPresence);
  const results = [];

  for (const zone of zones.results) {
    const accuracyLimitM = asFiniteNumber(zone.gps_accuracy_limit_m, 50);
    const classified = classifyCirclePosition({
      centerLat: Number(zone.anchor_lat),
      centerLon: Number(zone.anchor_lon),
      radiusM: Number(zone.radius_m),
      sampleLat: Number(sample.lat),
      sampleLon: Number(sample.lon),
      accuracyM: reportedAccuracy,
      exitBufferM: asFiniteNumber(zone.exit_buffer_m, 10),
      entryBufferM: asFiniteNumber(zone.entry_buffer_m, 5),
    });
    const classification = reportedAccuracy > accuracyLimitM
      ? CIRCLE_POSITION.UNCERTAIN
      : classified.classification;
    const current = stateFromRow(zone);
    const next = advanceAllowedZoneState(current, classification, capturedAtMs, {
      confirmSamples: asFiniteNumber(zone.confirm_samples, 2),
      confirmSeconds: asFiniteNumber(zone.confirm_seconds, 0),
    });

    let lifecycleId = current.lifecycleId;
    if ((next.transition === ZONE_TRANSITION.EXIT_CANDIDATE
         || next.transition === ZONE_TRANSITION.EXIT_CONFIRMED)
        && !lifecycleId) {
      lifecycleId = crypto.randomUUID();
    }

    const evidence = {
      classification,
      distanceM: classified.distanceM,
      accuracyM: reportedAccuracy,
      capturedAt,
    };
    const alertSuppressed = next.transition === ZONE_TRANSITION.EXIT_CONFIRMED
      && trustedOwnerPresent;
    const suppressionReason = alertSuppressed ? 'authenticated_owner_present' : null;

    await persistZoneState(deviceId, zone, next, evidence, lifecycleId, env);
    const geofenceEventId = await recordGeofenceTransition({
      deviceId,
      zone,
      previousState: current.state,
      next,
      lifecycleId: lifecycleId ?? crypto.randomUUID(),
      sample,
      evidence,
      alertSuppressed,
      suppressionReason,
    }, env);

    if (next.transition === ZONE_TRANSITION.EXIT_CONFIRMED) {
      if (alertSuppressed) {
        await logEvent(deviceId, 'GEOFENCE_EXIT_AUTHORIZED', 'info', env, {
          lat: sample.lat,
          lon: sample.lon,
          payload: {
            lifecycle_id: lifecycleId,
            zone_uuid: zone.zone_uuid,
            suppression_reason: suppressionReason,
            owner_presence: ownerPresence,
          },
        });
      } else {
        await notifyExit(deviceId, zone, sample, evidence, lifecycleId, env);
      }
    } else if (next.transition === ZONE_TRANSITION.ENTRY_CONFIRMED) {
      await notifyResolved(deviceId, zone, sample, lifecycleId, env);
      lifecycleId = null;
      await persistZoneState(deviceId, zone, next, evidence, lifecycleId, env);
    } else if (next.transition === ZONE_TRANSITION.EXIT_CANCELLED) {
      lifecycleId = null;
      await persistZoneState(deviceId, zone, next, evidence, lifecycleId, env);
    }

    results.push({
      zoneId: zone.id,
      zoneUuid: zone.zone_uuid,
      zone: zone.label,
      state: next.state,
      transition: next.transition,
      classification,
      distanceM: classified.distanceM,
      accuracyM: reportedAccuracy,
      lifecycleId,
      eventId: geofenceEventId,
      alertSuppressed,
      suppressionReason,
    });
  }

  return results;
}

/**
 * Motion without GPS can indicate a van lift, but total acceleration includes
 * gravity. Only calibrated IMU data whose magnitude deviates materially from
 * 1 g is eligible; an ordinary resting value near 9.81 m/s² never alerts.
 */
export async function checkVanLift(deviceId, imu, gpsFix, env) {
  if (gpsFix || !imu?.calibrated) return false;

  const atotal = asFiniteNumber(imu.atotal, null);
  if (atotal == null) return false;
  const dynamicAcceleration = Math.abs(atotal - STANDARD_GRAVITY_MS2);
  if (dynamicAcceleration <= MOTION_THRESHOLD) return false;

  if (await recentEventExists(deviceId, 'MOTION_SIGNAL_LOSS', 5, env)) return false;

  await logEvent(deviceId, 'MOTION_SIGNAL_LOSS', 'critical', env, {
    payload: {
      atotal,
      dynamic_acceleration_m_s2: dynamicAcceleration,
      imu_calibrated: true,
      reason: 'Possible van-lift theft',
    },
  });

  const chatId = await getUserChatIdForDevice(deviceId, env);
  if (chatId) {
    const strings = getBotStrings(await getLanguageForDevice(deviceId, env));
    await sendTelegramMessage(chatId, strings.vanLift({ deviceId }), env, { deviceId });
  }

  return true;
}

/**
 * Heartbeat timeout: armed device silent for longer than configured.
 */
export async function checkHeartbeatTimeout(deviceId, env) {
  const timeoutMs = Number(env.HEARTBEAT_TIMEOUT_MS ?? 600000);

  const latest = await env.DB.prepare(
    `SELECT received_at, arm_state FROM telemetry
     WHERE device_id = ? ORDER BY received_at DESC LIMIT 1`
  ).bind(deviceId).first();

  if (!latest) return;

  const lastSeen = new Date(`${latest.received_at}Z`).getTime();
  const elapsed = Date.now() - lastSeen;

  if (elapsed <= timeoutMs || latest.arm_state !== 1) return;
  if (await recentEventExists(deviceId, 'HEARTBEAT_TIMEOUT', 30, env)) return;

  await logEvent(deviceId, 'HEARTBEAT_TIMEOUT', 'warning', env, {
    payload: { elapsed_ms: elapsed },
  });

  const chatId = await getUserChatIdForDevice(deviceId, env);
  if (chatId) {
    const strings = getBotStrings(await getLanguageForDevice(deviceId, env));
    await sendTelegramMessage(chatId, strings.heartbeatTimeout({
      deviceId,
      lastSeen: latest.received_at,
    }), env, { deviceId });
  }
}
