import {
  createSessionToken,
  validateTelegramInitData,
} from '../lib/auth.js';
import {
  latestTelemetry,
  logEvent,
  queueDeviceCommand,
  upsertUser,
} from '../lib/db.js';
import { haversineDistance, isValidCoordinate } from '../lib/geo.js';
import { createInvoice } from '../lib/payments.js';
import {
  isSharedPrototypeReadOnly,
  resolveControlDeviceId,
  resolveTelemetryDeviceId,
  serializeClientDevice,
  serializeClientTelemetry,
} from '../lib/device-alias.js';
import { connectivityFromTelemetry, parseDatabaseTimestamp } from '../lib/device-status.js';
import {
  deriveFirmwareUpdateState,
  FIRMWARE_DOWNLOAD_PREFERENCES,
  FIRMWARE_BOARD,
  normalizeFirmwareDownloadPreference,
  summarizeFirmwareRelease,
} from '../lib/firmware-ota.js';
import {
  buildDetailedTrailExperience,
  buildTrailExperience,
  resolveTrailWindow,
} from '../lib/trail.js';
import {
  decryptWifiProfile,
  encryptWifiProfile,
  serializeWifiProfile,
  validateWifiProfileInput,
} from '../lib/wifi-credentials.js';

const json = (data, status = 200) => Response.json(data, { status });
const PARKING_CLUSTER_RADIUS_M = 75;
const PARKING_MIN_SAMPLES = 12;
const PARKING_MIN_DAYS = 3;
const PARKING_MODEL_VERSION = 'parking-cluster-v1';
const MAX_TRIP_ROUTE_POINTS = 50_000;

function parseJsonObject(value) {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return null;
}

function serializeTrip(row, nowMs = Date.now()) {
  const {
    last_moving_at: lastMovingAt,
    stationary_since: stationarySince,
    client_device_id: clientDeviceId,
    ...trip
  } = row;
  const startMs = parseDatabaseTimestamp(row.start_time);
  const endMs = row.end_time == null ? nowMs : parseDatabaseTimestamp(row.end_time);
  const durationSeconds = startMs == null || endMs == null
    ? 0
    : Math.max(0, Math.round((endMs - startMs) / 1_000));
  const distanceKm = Number(row.distance_km ?? 0);
  const calculatedAverage = durationSeconds > 0
    ? distanceKm / (durationSeconds / 3_600)
    : 0;
  return {
    ...trip,
    device_id: clientDeviceId ?? row.device_id,
    distance_km: distanceKm,
    max_speed_kmh: Number(row.max_speed_kmh ?? 0),
    avg_speed_kmh: Number.isFinite(calculatedAverage) ? calculatedAverage : 0,
    duration_seconds: durationSeconds,
    status: row.end_time == null ? 'ongoing' : 'completed',
  };
}

function serializeZone(zone) {
  return {
    id: zone.zone_uuid,
    device_id: zone.device_id,
    name: zone.label,
    type: zone.zone_type,
    policy: zone.policy_type,
    status: zone.status,
    version: Number(zone.version),
    geometry: {
      type: 'Circle',
      center: [Number(zone.anchor_lon), Number(zone.anchor_lat)],
      radius_m: Number(zone.radius_m),
    },
    rules: {
      exit_buffer_m: Number(zone.exit_buffer_m),
      entry_buffer_m: Number(zone.entry_buffer_m),
      confirm_samples: Number(zone.confirm_samples),
      confirm_seconds: Number(zone.confirm_seconds),
      gps_accuracy_limit_m: Number(zone.gps_accuracy_limit_m),
    },
    schedule: zone.schedule_json ? JSON.parse(zone.schedule_json) : null,
    state: zone.live_state ? {
      value: zone.live_state,
      classification: zone.last_classification,
      distance_m: zone.last_distance_m,
      accuracy_m: zone.last_accuracy_m,
      sample_at: zone.last_sample_at,
    } : null,
    created_at: zone.created_at,
    updated_at: zone.updated_at,
  };
}

function serializeSuggestion(row) {
  return {
    id: row.suggestion_uuid,
    name: row.suggested_name,
    center: [Number(row.center_lon), Number(row.center_lat)],
    radius_m: Number(row.suggested_radius_m),
    sample_count: Number(row.sample_count),
    distinct_days: Number(row.distinct_days),
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    confidence: Number(row.confidence),
    status: row.status,
    model_version: row.model_version,
  };
}

async function refreshPlaceSuggestions(deviceId, telemetryDeviceId, env) {
  const [samplesResult, zonesResult] = await Promise.all([
    env.DB.prepare(
      `SELECT gps_lat, gps_lon, gps_accuracy_m,
              COALESCE(captured_at, received_at) AS sampled_at
       FROM telemetry
       WHERE device_id = ? AND gps_fix = 1
         AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
         AND COALESCE(gps_accuracy_m, 15) <= 50
         AND COALESCE(gps_speed, 0) <= 1
         AND (motion_state IS NULL OR motion_state = 'stationary')
         AND received_at >= datetime('now', '-30 days')
       ORDER BY received_at DESC LIMIT 1000`
    ).bind(telemetryDeviceId).all(),
    env.DB.prepare(
      `SELECT anchor_lat, anchor_lon, radius_m
       FROM geofence_zones
       WHERE device_id = ? AND status != 'archived'`
    ).bind(deviceId).all(),
  ]);

  const samples = (samplesResult.results ?? []).filter((sample) => (
    isValidCoordinate(Number(sample.gps_lat), Number(sample.gps_lon))
    && !(Number(sample.gps_lat) === 0 && Number(sample.gps_lon) === 0)
  ));
  const clusters = [];
  for (const sample of samples) {
    const lat = Number(sample.gps_lat);
    const lon = Number(sample.gps_lon);
    let cluster = clusters.find((candidate) => (
      haversineDistance(candidate.lat, candidate.lon, lat, lon) <= PARKING_CLUSTER_RADIUS_M
    ));
    if (!cluster) {
      cluster = {
        lat,
        lon,
        count: 0,
        days: new Set(),
        firstSeen: sample.sampled_at,
        lastSeen: sample.sampled_at,
        maxDistanceM: 0,
        accuracyTotal: 0,
      };
      clusters.push(cluster);
    }
    const nextCount = cluster.count + 1;
    cluster.lat = ((cluster.lat * cluster.count) + lat) / nextCount;
    cluster.lon = ((cluster.lon * cluster.count) + lon) / nextCount;
    cluster.count = nextCount;
    cluster.days.add(String(sample.sampled_at).slice(0, 10));
    cluster.firstSeen = String(sample.sampled_at) < String(cluster.firstSeen)
      ? sample.sampled_at : cluster.firstSeen;
    cluster.lastSeen = String(sample.sampled_at) > String(cluster.lastSeen)
      ? sample.sampled_at : cluster.lastSeen;
    cluster.accuracyTotal += Number(sample.gps_accuracy_m ?? 15);
  }

  for (const cluster of clusters) {
    for (const sample of samples) {
      const distance = haversineDistance(
        cluster.lat,
        cluster.lon,
        Number(sample.gps_lat),
        Number(sample.gps_lon),
      );
      if (distance <= PARKING_CLUSTER_RADIUS_M) {
        cluster.maxDistanceM = Math.max(cluster.maxDistanceM, distance);
      }
    }
  }

  const candidates = clusters.filter((cluster) => (
    cluster.count >= PARKING_MIN_SAMPLES && cluster.days.size >= PARKING_MIN_DAYS
  )).filter((cluster) => !(zonesResult.results ?? []).some((zone) => (
    haversineDistance(
      Number(zone.anchor_lat),
      Number(zone.anchor_lon),
      cluster.lat,
      cluster.lon,
    ) <= Number(zone.radius_m) + 25
  )));

  for (const cluster of candidates.slice(0, 5)) {
    const fingerprint = `${cluster.lat.toFixed(4)},${cluster.lon.toFixed(4)}`;
    const meanAccuracy = cluster.accuracyTotal / cluster.count;
    const radiusM = Math.max(60, Math.min(250,
      Math.ceil((cluster.maxDistanceM + meanAccuracy + 15) / 10) * 10));
    const confidence = Math.min(0.98,
      0.4 + cluster.days.size * 0.07 + Math.min(cluster.count, 50) * 0.006);
    await env.DB.prepare(
      `INSERT INTO place_suggestions (
         suggestion_uuid, device_id, fingerprint, center_lat, center_lon,
         suggested_radius_m, sample_count, distinct_days, first_seen_at,
         last_seen_at, confidence, status, model_version, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now'))
       ON CONFLICT(device_id, fingerprint) DO UPDATE SET
         center_lat = excluded.center_lat,
         center_lon = excluded.center_lon,
         suggested_radius_m = excluded.suggested_radius_m,
         sample_count = excluded.sample_count,
         distinct_days = excluded.distinct_days,
         first_seen_at = excluded.first_seen_at,
         last_seen_at = excluded.last_seen_at,
         confidence = excluded.confidence,
         updated_at = datetime('now')`
    ).bind(
      `sgz-${crypto.randomUUID()}`,
      deviceId,
      fingerprint,
      cluster.lat,
      cluster.lon,
      radiusM,
      cluster.count,
      cluster.days.size,
      cluster.firstSeen,
      cluster.lastSeen,
      confidence,
      PARKING_MODEL_VERSION,
    ).run();
  }

  const distinctDays = new Set(samples.map((sample) => String(sample.sampled_at).slice(0, 10))).size;
  return {
    eligible_samples: samples.length,
    distinct_days: distinctDays,
    minimum_samples: PARKING_MIN_SAMPLES,
    minimum_days: PARKING_MIN_DAYS,
  };
}

async function getOwnedDevice(userId, deviceId, env) {
  return env.DB.prepare(
    `SELECT * FROM devices
     WHERE device_id = ? AND owner_id = ? AND is_active = 1`
  ).bind(deviceId, userId).first();
}

async function activeDeviceCredential(deviceId, env) {
  return env.DB.prepare(
    `SELECT key_version FROM device_credentials
     WHERE device_id = ? AND status = 'active'
     ORDER BY key_version DESC LIMIT 1`
  ).bind(deviceId).first();
}

async function latestFirmwareRelease(deviceId, env) {
  return env.DB.prepare(
    `SELECT r.* FROM firmware_releases r
     JOIN firmware_rollouts ro ON ro.release_uuid = r.release_uuid
     WHERE r.status = 'active' AND r.board = ? AND ro.device_id = ?
     ORDER BY build_number DESC LIMIT 1`
  ).bind(FIRMWARE_BOARD, deviceId).first();
}

async function firmwareRollout(deviceId, releaseId, env) {
  if (!releaseId) return null;
  return env.DB.prepare(
    `SELECT * FROM firmware_rollouts
     WHERE device_id = ? AND release_uuid = ?`
  ).bind(deviceId, releaseId).first();
}

async function firmwareCommand(deviceId, releaseId, env, activeOnly = false) {
  if (!releaseId) return null;
  const activeFilter = activeOnly ? "AND status IN ('pending', 'delivered')" : '';
  return env.DB.prepare(
    `SELECT id, status, payload_json, delivered_at, acknowledged_at, ack_status, created_at
     FROM device_commands
     WHERE device_id = ? AND command = 'OTA'
       AND json_extract(payload_json, '$.release_id') = ?
       ${activeFilter}
     ORDER BY id DESC LIMIT 1`
  ).bind(deviceId, releaseId).first();
}

async function firmwareUpdateSnapshot(device, env) {
  const controlDeviceId = resolveControlDeviceId(device, env);
  const controlDevice = controlDeviceId === device.device_id
    ? device
    : await env.DB.prepare('SELECT * FROM devices WHERE device_id = ?')
      .bind(controlDeviceId).first();
  if (!controlDevice) return null;

  const release = await latestFirmwareRelease(controlDeviceId, env);
  const releaseId = release?.release_uuid ?? null;
  const [rollout, command, credential, latest, wifiProfiles] = await Promise.all([
    firmwareRollout(controlDeviceId, releaseId, env),
    firmwareCommand(controlDeviceId, releaseId, env),
    activeDeviceCredential(controlDeviceId, env),
    latestTelemetry(controlDeviceId, env),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM wifi_profiles
       WHERE device_id = ? AND status = 'active'`
    ).bind(controlDeviceId).first(),
  ]);
  const connectivity = connectivityFromTelemetry(
    latest,
    Number(env.HEARTBEAT_TIMEOUT_MS ?? 600000),
  );
  const readOnly = isSharedPrototypeReadOnly(device, env);
  let downloadPreference = FIRMWARE_DOWNLOAD_PREFERENCES.WIFI_ONLY;
  try {
    downloadPreference = normalizeFirmwareDownloadPreference(
      JSON.parse(command?.payload_json ?? '{}').download_preference,
    );
  } catch { /* retain the safe Wi-Fi default */ }
  const state = deriveFirmwareUpdateState({
    currentBuild: controlDevice.firmware_build,
    release,
    rollout,
    command,
    credentialActive: Boolean(credential),
    readOnly,
  });

  return {
    device_id: device.device_id,
    current: {
      version: String(controlDevice.firmware_ver ?? 'unknown'),
      build_number: Number(controlDevice.firmware_build ?? 0),
    },
    update: {
      status: state,
      can_install: ['available', 'failed'].includes(state),
      release: summarizeFirmwareRelease(release),
      failure_reason: rollout?.failure_reason ?? null,
      requested_at: command?.created_at ?? null,
      delivered_at: command?.delivered_at ?? rollout?.offered_at ?? null,
      installed_at: rollout?.installed_at ?? command?.acknowledged_at ?? null,
      download_preference: downloadPreference,
    },
    readiness: {
      signed_bootstrap: Number(controlDevice.firmware_build ?? 0) > 0
        && Boolean(credential),
      tracker_online: connectivity.status === 'online',
      trusted_wifi_configured: Number(wifiProfiles?.count ?? 0) > 0,
      trusted_wifi_connected: connectivity.status === 'online'
        && connectivity.transport === 'wifi'
        && Boolean(latest?.uplink_profile_id),
      cellular_connected: connectivity.status === 'online'
        && connectivity.transport === 'cellular',
      any_internet_connected: connectivity.status === 'online'
        && ['wifi', 'cellular'].includes(connectivity.transport),
      disarmed: Number(latest?.arm_state) === 0,
      stationary: latest?.motion_state !== 'moving',
    },
    checked_at: new Date().toISOString(),
  };
}

async function queueWifiConfigSync(deviceId, env) {
  const device = await env.DB.prepare(
    `UPDATE devices SET
       wifi_config_revision = wifi_config_revision + 1,
       updated_at = datetime('now')
     WHERE device_id = ?
     RETURNING wifi_config_revision`
  ).bind(deviceId).first();
  const revision = Number(device?.wifi_config_revision ?? 0);
  await queueDeviceCommand(deviceId, 'WIFI_SYNC', env, { revision });
  return revision;
}

async function getOwnedWifiProfile(userId, profileId, env) {
  const profile = await env.DB.prepare(
    'SELECT * FROM wifi_profiles WHERE profile_uuid = ?'
  ).bind(profileId).first();
  if (!profile) return null;
  const devices = await env.DB.prepare(
    'SELECT * FROM devices WHERE owner_id = ? AND is_active = 1'
  ).bind(userId).all();
  const accessDevice = (devices.results ?? []).find(
    (device) => resolveControlDeviceId(device, env) === profile.device_id,
  );
  return accessDevice ? { ...profile, access_device_id: accessDevice.device_id } : null;
}

function wifiSyncState(device) {
  const revision = Number(device.wifi_config_revision ?? 0);
  const appliedRevision = Number(device.wifi_config_applied_revision ?? 0);
  return {
    revision,
    applied_revision: appliedRevision,
    status: appliedRevision >= revision ? 'synced' : 'pending',
  };
}

async function getOwnedZone(userId, zoneUuid, env) {
  return env.DB.prepare(
    `SELECT z.* FROM geofence_zones z
     JOIN devices d ON d.device_id = z.device_id
     WHERE z.zone_uuid = ? AND d.owner_id = ?`
  ).bind(zoneUuid, userId).first();
}

function validateCircleInput(body, current = null) {
  const geometry = parseJsonObject(body.geometry);
  const rules = parseJsonObject(body.rules) ?? {};
  const center = geometry?.center ?? (
    current ? [Number(current.anchor_lon), Number(current.anchor_lat)] : null
  );
  const label = String(body.name ?? current?.label ?? '').trim();
  const radiusM = Number(geometry?.radius_m ?? current?.radius_m);
  const anchorLon = Number(center?.[0]);
  const anchorLat = Number(center?.[1]);
  const status = body.status ?? current?.status ?? 'active';
  const policy = body.policy ?? current?.policy_type ?? 'safe';
  const schedule = body.schedule === undefined
    ? (current?.schedule_json ? JSON.parse(current.schedule_json) : null)
    : body.schedule;

  const result = {
    label,
    anchorLat,
    anchorLon,
    radiusM,
    status,
    policy,
    exitBufferM: Number(rules.exit_buffer_m ?? current?.exit_buffer_m ?? 10),
    entryBufferM: Number(rules.entry_buffer_m ?? current?.entry_buffer_m ?? 5),
    confirmSamples: Number(rules.confirm_samples ?? current?.confirm_samples ?? 2),
    confirmSeconds: Number(rules.confirm_seconds ?? current?.confirm_seconds ?? 0),
    accuracyLimitM: Number(
      rules.gps_accuracy_limit_m ?? current?.gps_accuracy_limit_m ?? 50,
    ),
    schedule,
  };

  if (!label || label.length > 80) return { error: 'zone_name_invalid' };
  if (!isValidCoordinate(anchorLat, anchorLon)
      || (anchorLat === 0 && anchorLon === 0)) {
    return { error: 'zone_center_invalid' };
  }
  if (!Number.isFinite(radiusM) || radiusM < 50 || radiusM > 5000) {
    return { error: 'zone_radius_out_of_range', min_radius_m: 50, max_radius_m: 5000 };
  }
  if (!['active', 'paused', 'archived'].includes(status)) {
    return { error: 'zone_status_invalid' };
  }
  if (policy !== 'safe') return { error: 'zone_policy_not_supported' };
  if (!Number.isFinite(result.exitBufferM) || result.exitBufferM < 0 || result.exitBufferM > 500
      || !Number.isFinite(result.entryBufferM) || result.entryBufferM < 0 || result.entryBufferM > 500
      || !Number.isInteger(result.confirmSamples) || result.confirmSamples < 1 || result.confirmSamples > 10
      || !Number.isInteger(result.confirmSeconds) || result.confirmSeconds < 0 || result.confirmSeconds > 300
      || !Number.isFinite(result.accuracyLimitM) || result.accuracyLimitM < 5 || result.accuracyLimitM > 500) {
    return { error: 'zone_rules_invalid' };
  }
  if (schedule != null && !parseJsonObject(schedule)) return { error: 'zone_schedule_invalid' };

  return { value: result };
}

async function snapshotZone(zone, actor, env) {
  await env.DB.prepare(
    `INSERT INTO geofence_zone_versions (
       zone_id, version, label, zone_type, policy_type,
       anchor_lat, anchor_lon, radius_m,
       exit_buffer_m, entry_buffer_m, confirm_samples, confirm_seconds,
       gps_accuracy_limit_m, schedule_json, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    zone.id,
    zone.version,
    zone.label,
    zone.zone_type,
    zone.policy_type,
    zone.anchor_lat,
    zone.anchor_lon,
    zone.radius_m,
    zone.exit_buffer_m,
    zone.entry_buffer_m,
    zone.confirm_samples,
    zone.confirm_seconds,
    zone.gps_accuracy_limit_m,
    zone.schedule_json,
    actor.userId,
  ).run();
}

async function audit(actor, requestId, action, resourceType, resourceId, env, {
  before = null,
  after = null,
} = {}) {
  await env.DB.prepare(
    `INSERT INTO audit_log (
       request_id, actor_type, actor_id, action, resource_type,
       resource_id, before_json, after_json
     ) VALUES (?, 'user', ?, ?, ?, ?, ?, ?)`
  ).bind(
    requestId,
    String(actor.userId),
    action,
    resourceType,
    resourceId ?? null,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
  ).run();
}

export async function handleTelegramSession(body, env) {
  if (!env.APP_SESSION_SECRET) {
    return json({ error: 'session_service_not_configured' }, 503);
  }
  const validated = await validateTelegramInitData(
    body.init_data,
    env.TELEGRAM_BOT_TOKEN,
    { maxAgeSeconds: Number(env.TELEGRAM_AUTH_MAX_AGE_SECONDS ?? 300) },
  );
  if (!validated.ok) return json({ error: validated.error }, 401);

  const profile = validated.user;
  const displayName = `${profile.firstName} ${profile.lastName}`.trim() || 'Rider';
  const user = await upsertUser({
    telegramId: profile.id,
    handle: profile.username,
    displayName,
  }, env);
  const expiresIn = Number(env.APP_SESSION_TTL_SECONDS ?? 900);
  const token = await createSessionToken({
    userId: user.id,
    telegramId: user.telegram_id,
  }, env.APP_SESSION_SECRET, { ttlSeconds: expiresIn });

  return json({
    token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    user: {
      display_name: user.display_name,
      telegram_handle: user.telegram_handle,
      language: user.language,
    },
  });
}

export async function handleGetMeV2(actor, env) {
  const user = await env.DB.prepare(
    `SELECT id, display_name, telegram_handle, language
     FROM users WHERE id = ?`
  ).bind(actor.userId).first();
  if (!user) return json({ error: 'user_not_found' }, 404);

  const devices = await env.DB.prepare(
    `SELECT * FROM devices
     WHERE owner_id = ? AND is_active = 1 ORDER BY created_at`
  ).bind(actor.userId).all();
  const results = [];
  for (const device of devices.results ?? []) {
    const telemetryDeviceId = resolveTelemetryDeviceId(device);
    const [latest, zones] = await Promise.all([
      latestTelemetry(telemetryDeviceId, env),
      env.DB.prepare(
        `SELECT z.*, s.state AS live_state, s.last_classification,
                s.last_distance_m, s.last_accuracy_m, s.last_sample_at
         FROM geofence_zones z
         LEFT JOIN device_zone_state s
           ON s.device_id = z.device_id AND s.zone_id = z.id
         WHERE z.device_id = ? AND z.status != 'archived'
         ORDER BY z.created_at DESC`
      ).bind(device.device_id).all(),
    ]);
    results.push({
      ...serializeClientDevice(device, env),
      latest_telemetry: serializeClientTelemetry(latest, device),
      connectivity: connectivityFromTelemetry(
        latest,
        Number(env.HEARTBEAT_TIMEOUT_MS ?? 600000),
      ),
      geofences: (zones.results ?? []).map(serializeZone),
    });
  }

  return json({
    user: {
      display_name: user.display_name,
      telegram_handle: user.telegram_handle,
      language: user.language,
    },
    devices: results,
  });
}

export async function handleGetLiveDeviceV2(actor, deviceId, env) {
  const device = await getOwnedDevice(actor.userId, deviceId, env);
  if (!device) return json({ error: 'device_not_found' }, 404);
  const telemetryDeviceId = resolveTelemetryDeviceId(device);

  const [latest, zones, events, trail] = await Promise.all([
    latestTelemetry(telemetryDeviceId, env),
    env.DB.prepare(
      `SELECT z.*, s.state AS live_state, s.last_classification,
              s.last_distance_m, s.last_accuracy_m, s.last_sample_at
       FROM geofence_zones z
       LEFT JOIN device_zone_state s
         ON s.device_id = z.device_id AND s.zone_id = z.id
       WHERE z.device_id = ? AND z.status != 'archived'
       ORDER BY z.created_at DESC`
    ).bind(deviceId).all(),
    env.DB.prepare(
      `SELECT event_uuid, lifecycle_id, zone_id, zone_version, transition,
              state_from, state_to, gps_lat, gps_lon, distance_m, accuracy_m,
              acknowledged_at, occurred_at
       FROM geofence_events WHERE device_id = ?
       ORDER BY occurred_at DESC LIMIT 50`
    ).bind(deviceId).all(),
    env.DB.prepare(
      `SELECT gps_lat AS lat, gps_lon AS lon, gps_accuracy_m AS accuracy_m,
              gps_hdop AS hdop, gps_satellites AS satellites,
              gps_speed AS speed_kmh, gps_heading AS heading,
              arm_state, motion_state, crash_stage,
              uplink_type, uplink_signal_dbm, uplink_generation,
              captured_at, received_at
       FROM telemetry
       WHERE device_id = ? AND gps_fix = 1
         AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
         AND datetime(COALESCE(captured_at, received_at)) >= datetime('now', '-6 hours')
       ORDER BY datetime(COALESCE(captured_at, received_at)) DESC, id DESC LIMIT 80`
    ).bind(telemetryDeviceId).all(),
  ]);
  const recentTrail = buildTrailExperience((trail.results ?? []).reverse(), 90);

  return json({
    device: serializeClientDevice(device, env),
    latest_telemetry: serializeClientTelemetry(latest, device),
    connectivity: connectivityFromTelemetry(
      latest,
      Number(env.HEARTBEAT_TIMEOUT_MS ?? 600000),
    ),
    zones: (zones.results ?? []).map(serializeZone),
    recent_geofence_events: events.results ?? [],
    trail: recentTrail.points,
    trail_summary: recentTrail.summary,
  });
}

/**
 * Bounded historical route for the map timeline. Raw GPS points are retained
 * through the query and only geometrically redundant points are removed after
 * the gap markers and distance summary have been calculated.
 */
export async function handleGetDeviceTrailV2(actor, deviceId, requestUrl, env) {
  const device = await getOwnedDevice(actor.userId, deviceId, env);
  if (!device) return json({ error: 'device_not_found' }, 404);
  const window = resolveTrailWindow(requestUrl);
  if (!window.ok) return json({ error: window.error }, 400);
  const telemetryDeviceId = resolveTelemetryDeviceId(device);

  const [trail, events, geofenceEvents] = await Promise.all([
    env.DB.prepare(
      `SELECT t.gps_lat AS lat, t.gps_lon AS lon,
              t.gps_accuracy_m AS accuracy_m, t.gps_hdop AS hdop,
              t.gps_satellites AS satellites, t.gps_speed AS speed_kmh,
              t.gps_heading AS heading, t.arm_state, t.motion_state,
              t.crash_stage, t.uplink_type, t.uplink_signal_dbm,
              t.uplink_generation, t.captured_at, t.received_at
       FROM telemetry t
       WHERE t.device_id = ? AND t.gps_fix = 1
         AND t.gps_lat IS NOT NULL AND t.gps_lon IS NOT NULL
         AND (
           (t.captured_at IS NOT NULL AND t.captured_at >= ? AND t.captured_at <= ?)
           OR
           (t.captured_at IS NULL AND t.received_at >= ? AND t.received_at <= ?)
         )
       ORDER BY datetime(COALESCE(t.captured_at, t.received_at)) ASC, t.id ASC
       LIMIT ?`
    ).bind(
      telemetryDeviceId,
      window.fromIso,
      window.toIso,
      window.fromSql,
      window.toSql,
      window.limit,
    ).all(),
    env.DB.prepare(
      `SELECT id, event_type, severity, gps_lat, gps_lon,
              payload_json, created_at AS occurred_at
       FROM events
       WHERE device_id = ?
         AND created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC LIMIT 200`
    ).bind(telemetryDeviceId, window.fromSql, window.toSql).all(),
    env.DB.prepare(
      `SELECT g.event_uuid AS id, g.transition, g.gps_lat, g.gps_lon,
              g.distance_m, g.accuracy_m, g.occurred_at, z.label AS zone_name
       FROM geofence_events g
       JOIN geofence_zones z ON z.id = g.zone_id
       WHERE g.device_id = ?
         AND datetime(g.occurred_at) >= datetime(?)
         AND datetime(g.occurred_at) <= datetime(?)
       ORDER BY g.occurred_at ASC LIMIT 200`
    ).bind(deviceId, window.fromIso, window.toIso).all(),
  ]);

  const trailRows = trail.results ?? [];
  const sourceTruncated = trailRows.length === window.limit;
  if (sourceTruncated) trailRows.pop();
  const experience = buildDetailedTrailExperience(
    trailRows,
    window.gapThresholdSeconds,
    window.detailToleranceM,
  );
  experience.summary.source_truncated = sourceTruncated;
  const historyEvents = [
    ...(events.results ?? []).map((event) => ({
      ...event,
      source: 'device',
    })),
    ...(geofenceEvents.results ?? []).map((event) => ({
      ...event,
      event_type: `GEOFENCE_${event.transition}`,
      severity: event.transition === 'EXIT_CONFIRMED' ? 'warning' : 'info',
      source: 'geofence',
    })),
  ].sort((left, right) => String(left.occurred_at).localeCompare(String(right.occurred_at)));

  return json({
    device: serializeClientDevice(device, env),
    window: {
      range: window.range,
      from: window.fromIso,
      to: window.toIso,
      bucket_seconds: null,
      detail_tolerance_m: window.detailToleranceM,
    },
    points: experience.points,
    summary: experience.summary,
    events: historyEvents,
  });
}

export async function handleGetActivityV2(actor, env) {
  const device = await env.DB.prepare(
    `SELECT * FROM devices
     WHERE owner_id = ? AND is_active = 1 ORDER BY created_at LIMIT 1`
  ).bind(actor.userId).first();
  if (!device) return json({ trips: [], events: [] });
  const telemetryDeviceId = resolveTelemetryDeviceId(device);

  const [trips, events, geofenceEvents] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM trips WHERE device_id = ? ORDER BY start_time DESC LIMIT 20`
    ).bind(telemetryDeviceId).all(),
    env.DB.prepare(
      `SELECT * FROM events WHERE device_id = ? ORDER BY created_at DESC LIMIT 30`
    ).bind(telemetryDeviceId).all(),
    env.DB.prepare(
      `SELECT g.event_uuid AS id, g.transition, g.state_from, g.state_to,
              g.gps_lat, g.gps_lon, g.distance_m, g.accuracy_m,
              g.acknowledged_at, g.occurred_at AS created_at,
              z.label AS zone_name
       FROM geofence_events g
       JOIN geofence_zones z ON z.id = g.zone_id
       WHERE g.device_id = ?
       ORDER BY g.occurred_at DESC LIMIT 40`
    ).bind(device.device_id).all(),
  ]);
  const lifecycleEvents = (geofenceEvents.results ?? []).map((event) => ({
    ...event,
    event_type: `GEOFENCE_${event.transition}`,
    severity: event.transition === 'EXIT_CONFIRMED' ? 'warning' : 'info',
    source: 'geofence_v2',
  }));
  const combinedEvents = [...(events.results ?? []), ...lifecycleEvents]
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    .slice(0, 50);
  return json({
    device_id: device.device_id,
    connection_mode: isSharedPrototypeReadOnly(device, env) ? 'shared_prototype' : 'dedicated',
    trips: (trips.results ?? []).map((trip) => serializeTrip(trip)),
    events: combinedEvents,
  });
}

export async function handleGetTripV2(actor, tripId, env) {
  if (!/^\d+$/u.test(String(tripId))) return json({ error: 'trip_not_found' }, 404);
  const trip = await env.DB.prepare(
    `SELECT tr.*, d.device_id AS client_device_id
     FROM trips tr
     JOIN devices d
       ON d.owner_id = ? AND d.is_active = 1
      AND tr.device_id = COALESCE(d.telemetry_source_device_id, d.device_id)
     WHERE tr.id = ?
     ORDER BY d.created_at ASC LIMIT 1`
  ).bind(actor.userId, Number(tripId)).first();
  if (!trip) return json({ error: 'trip_not_found' }, 404);

  const routeEnd = trip.end_time ?? new Date().toISOString();
  const routeResult = await env.DB.prepare(
    `SELECT id, gps_lat AS lat, gps_lon AS lon,
            gps_accuracy_m AS accuracy_m, gps_speed AS speed_kmh,
            gps_heading AS heading, motion_state, captured_at, received_at
     FROM telemetry
     WHERE device_id = ? AND gps_fix = 1
       AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
       AND (
         trip_id = ?
         OR (
           trip_id IS NULL
           AND datetime(COALESCE(captured_at, received_at)) >= datetime(?)
           AND datetime(COALESCE(captured_at, received_at)) <= datetime(?)
         )
       )
     ORDER BY datetime(COALESCE(captured_at, received_at)) ASC, id ASC
     LIMIT ?`
  ).bind(
    trip.device_id,
    trip.id,
    trip.start_time,
    routeEnd,
    MAX_TRIP_ROUTE_POINTS + 1,
  ).all();
  const routeRows = routeResult.results ?? [];
  const complete = routeRows.length <= MAX_TRIP_ROUTE_POINTS;
  if (!complete) routeRows.pop();
  const route = buildTrailExperience(routeRows, 90);

  return json({
    trip: serializeTrip(trip),
    route: {
      points: route.points,
      summary: route.summary,
      complete,
    },
  });
}

export async function handleSetLanguageV2(actor, body, env, requestId) {
  if (!['en', 'km'].includes(body.language)) {
    return json({ error: 'language_invalid' }, 400);
  }
  await env.DB.prepare(
    `UPDATE users SET language = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(body.language, actor.userId).run();
  await audit(actor, requestId, 'user.language.update', 'user', String(actor.userId), env, {
    after: { language: body.language },
  });
  return json({ status: 'ok', language: body.language });
}

export async function handleCreateInvoiceV2(actor, env, requestId) {
  const user = await env.DB.prepare(
    'SELECT telegram_id FROM users WHERE id = ?'
  ).bind(actor.userId).first();
  if (!user) return json({ error: 'user_not_found' }, 404);
  const invoice = await createInvoice(user.telegram_id, env);
  if (invoice.error) return json({ error: invoice.error }, 400);
  await audit(actor, requestId, 'invoice.create', 'payment_invoice', invoice.invoice_ref, env);
  return json(invoice, 201);
}

export async function handleGetInvoiceStatusV2(actor, invoiceRef, env) {
  const invoice = await env.DB.prepare(
    `SELECT p.status, p.paid_at, p.payway_txn_id
     FROM payment_invoices p
     WHERE p.invoice_ref = ? AND p.user_id = ?`
  ).bind(invoiceRef, actor.userId).first();
  if (!invoice) return json({ error: 'invoice_not_found' }, 404);
  return json({
    status: invoice.status,
    paid_at: invoice.paid_at,
    txn_id: invoice.payway_txn_id,
  });
}

export async function handleLinkDeviceV2(actor, body, env, requestId) {
  const deviceId = String(body.device_id ?? '').toUpperCase().trim();
  if (!/^BB-[A-Z0-9-]{4,}$/u.test(deviceId)) {
    return json({ error: 'invalid_device_id' }, 400);
  }

  const device = await env.DB.prepare(
    `SELECT d.*,
            EXISTS(SELECT 1 FROM device_credentials c WHERE c.device_id = d.device_id) AS provisioned
     FROM devices d WHERE d.device_id = ?`
  ).bind(deviceId).first();
  if (!device || !device.provisioned) {
    return json({ error: 'device_not_provisioned' }, 404);
  }
  if (device.owner_id && Number(device.owner_id) !== actor.userId) {
    return json({ error: 'device_taken' }, 409);
  }
  if (Number(device.owner_id) === actor.userId) {
    return json({ status: 'already_mine', device_id: deviceId });
  }

  await env.DB.prepare(
    `UPDATE devices SET owner_id = ?, updated_at = datetime('now')
     WHERE device_id = ? AND owner_id IS NULL`
  ).bind(actor.userId, deviceId).run();
  await audit(actor, requestId, 'device.claim', 'device', deviceId, env, {
    after: { owner_id: actor.userId },
  });
  return json({ status: 'linked', device_id: deviceId });
}

export async function handleListWifiProfilesV2(actor, deviceId, env) {
  const device = await getOwnedDevice(actor.userId, deviceId, env);
  if (!device) return json({ error: 'device_not_found' }, 404);
  const profileDeviceId = resolveControlDeviceId(device, env);
  const profileDevice = profileDeviceId === device.device_id
    ? device
    : await env.DB.prepare('SELECT * FROM devices WHERE device_id = ?').bind(profileDeviceId).first();
  const result = await env.DB.prepare(
    `SELECT * FROM wifi_profiles
     WHERE device_id = ? AND status != 'archived'
     ORDER BY priority DESC, created_at ASC`
  ).bind(profileDeviceId).all();

  const profiles = [];
  for (const row of result.results ?? []) {
    let decrypted = null;
    try {
      decrypted = await decryptWifiProfile({
        masterSecret: env.DEVICE_KEY_MASTER,
        deviceId: profileDeviceId,
        profileId: row.profile_uuid,
        version: Number(row.version),
        keyVersion: Number(row.key_version),
        nonce: row.credential_nonce,
        ciphertext: row.credential_ciphertext,
      });
    } catch {
      // Never return ciphertext or lower-level crypto errors to the client.
    }
    profiles.push(serializeWifiProfile(row, decrypted));
  }

  return json({
    profiles,
    maximum_profiles: 8,
    read_only: isSharedPrototypeReadOnly(device, env),
    sync: wifiSyncState(profileDevice ?? device),
    fallback: { type: 'cellular', generation: '4g', provider: 'A7670G' },
    security: { encrypted_at_rest: true, password_is_write_only: true },
  });
}

export async function handleCreateWifiProfileV2(actor, deviceId, body, env, requestId) {
  const device = await getOwnedDevice(actor.userId, deviceId, env);
  if (!device) return json({ error: 'device_not_found' }, 404);
  if (isSharedPrototypeReadOnly(device, env)) return json({ error: 'shared_prototype_read_only' }, 403);
  if (!env.DEVICE_KEY_MASTER) return json({ error: 'device_security_not_configured' }, 503);
  const profileDeviceId = resolveControlDeviceId(device, env);
  const profileDevice = profileDeviceId === device.device_id
    ? device
    : await env.DB.prepare('SELECT * FROM devices WHERE device_id = ?').bind(profileDeviceId).first();

  const validated = validateWifiProfileInput(body);
  if (!validated.ok) return json({ error: validated.error }, 400);
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM wifi_profiles
     WHERE device_id = ? AND status != 'archived'`
  ).bind(profileDeviceId).first();
  if (Number(count?.count ?? 0) >= 8) return json({ error: 'wifi_profile_limit' }, 409);

  const existing = await env.DB.prepare(
    `SELECT profile_uuid, version, key_version, credential_nonce, credential_ciphertext
     FROM wifi_profiles WHERE device_id = ? AND status != 'archived'`
  ).bind(profileDeviceId).all();
  for (const row of existing.results ?? []) {
    try {
      const profile = await decryptWifiProfile({
        masterSecret: env.DEVICE_KEY_MASTER,
        deviceId: profileDeviceId,
        profileId: row.profile_uuid,
        version: Number(row.version),
        keyVersion: Number(row.key_version),
        nonce: row.credential_nonce,
        ciphertext: row.credential_ciphertext,
      });
      if (profile.ssid === validated.value.ssid) {
        return json({ error: 'wifi_ssid_duplicate' }, 409);
      }
    } catch { /* an unreadable old row must not expose credential material */ }
  }

  const credential = await activeDeviceCredential(profileDeviceId, env);
  if (!credential) return json({ error: 'device_credential_inactive' }, 409);
  const profileId = crypto.randomUUID();
  const version = 1;
  const keyVersion = Number(credential.key_version);
  const profile = validated.value;
  const encrypted = await encryptWifiProfile({
    masterSecret: env.DEVICE_KEY_MASTER,
    deviceId: profileDeviceId,
    profileId,
    version,
    keyVersion,
    profile,
  });

  await env.DB.prepare(
    `INSERT INTO wifi_profiles (
       profile_uuid, device_id, label, credential_ciphertext,
       credential_nonce, key_version, priority, status, version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
  ).bind(
    profileId,
    profileDeviceId,
    profile.label,
    encrypted.ciphertext,
    encrypted.nonce,
    keyVersion,
    profile.priority,
    version,
  ).run();
  const revision = await queueWifiConfigSync(profileDeviceId, env);
  await audit(actor, requestId, 'device.wifi.create', 'wifi_profile', profileId, env, {
    after: { label: profile.label, priority: profile.priority, version },
  });

  const row = await env.DB.prepare(
    'SELECT * FROM wifi_profiles WHERE profile_uuid = ?'
  ).bind(profileId).first();
  return json({
    profile: serializeWifiProfile(row, profile),
    sync: { revision, applied_revision: Number(profileDevice?.wifi_config_applied_revision ?? 0), status: 'pending' },
  }, 201);
}

export async function handleUpdateWifiProfileV2(actor, profileId, body, env, requestId) {
  const row = await getOwnedWifiProfile(actor.userId, profileId, env);
  if (!row || row.status === 'archived') return json({ error: 'wifi_profile_not_found' }, 404);
  const device = await getOwnedDevice(actor.userId, row.access_device_id, env);
  if (!device || isSharedPrototypeReadOnly(device, env)) return json({ error: 'shared_prototype_read_only' }, 403);
  const expectedVersion = Number(body.version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== Number(row.version)) {
    return json({ error: 'wifi_profile_version_conflict', current_version: Number(row.version) }, 409);
  }
  const validated = validateWifiProfileInput(body, { partial: true });
  if (!validated.ok) return json({ error: validated.error }, 400);

  let current;
  try {
    current = await decryptWifiProfile({
      masterSecret: env.DEVICE_KEY_MASTER,
      deviceId: row.device_id,
      profileId,
      version: Number(row.version),
      keyVersion: Number(row.key_version),
      nonce: row.credential_nonce,
      ciphertext: row.credential_ciphertext,
    });
  } catch {
    return json({ error: 'wifi_profile_unreadable' }, 503);
  }
  const profile = { ...current, ...validated.value };
  const nextVersion = Number(row.version) + 1;
  const credential = await activeDeviceCredential(row.device_id, env);
  if (!credential) return json({ error: 'device_credential_inactive' }, 409);
  const keyVersion = Number(credential.key_version);
  const encrypted = await encryptWifiProfile({
    masterSecret: env.DEVICE_KEY_MASTER,
    deviceId: row.device_id,
    profileId,
    version: nextVersion,
    keyVersion,
    profile,
  });

  await env.DB.prepare(
    `UPDATE wifi_profiles SET
       label = ?, priority = ?, credential_ciphertext = ?, credential_nonce = ?,
       key_version = ?, version = ?, updated_at = datetime('now')
     WHERE profile_uuid = ? AND version = ?`
  ).bind(
    profile.label,
    profile.priority,
    encrypted.ciphertext,
    encrypted.nonce,
    keyVersion,
    nextVersion,
    profileId,
    expectedVersion,
  ).run();
  const revision = await queueWifiConfigSync(row.device_id, env);
  await audit(actor, requestId, 'device.wifi.update', 'wifi_profile', profileId, env, {
    before: { label: row.label, priority: Number(row.priority), version: Number(row.version) },
    after: { label: profile.label, priority: profile.priority, version: nextVersion },
  });
  const updated = await env.DB.prepare(
    'SELECT * FROM wifi_profiles WHERE profile_uuid = ?'
  ).bind(profileId).first();
  return json({
    profile: serializeWifiProfile(updated, profile),
    sync: { revision, applied_revision: Number(device.wifi_config_applied_revision ?? 0), status: 'pending' },
  });
}

export async function handleArchiveWifiProfileV2(actor, profileId, body, env, requestId) {
  const row = await getOwnedWifiProfile(actor.userId, profileId, env);
  if (!row || row.status === 'archived') return json({ error: 'wifi_profile_not_found' }, 404);
  const device = await getOwnedDevice(actor.userId, row.access_device_id, env);
  if (!device || isSharedPrototypeReadOnly(device, env)) return json({ error: 'shared_prototype_read_only' }, 403);
  if (Number(body.version) !== Number(row.version)) {
    return json({ error: 'wifi_profile_version_conflict', current_version: Number(row.version) }, 409);
  }
  await env.DB.prepare(
    `UPDATE wifi_profiles SET status = 'archived', version = version + 1,
       updated_at = datetime('now') WHERE profile_uuid = ? AND version = ?`
  ).bind(profileId, Number(row.version)).run();
  const revision = await queueWifiConfigSync(row.device_id, env);
  await audit(actor, requestId, 'device.wifi.archive', 'wifi_profile', profileId, env, {
    before: { label: row.label, priority: Number(row.priority), version: Number(row.version) },
  });
  return json({ status: 'archived', id: profileId, sync: { revision, status: 'pending' } });
}

export async function handleGetFirmwareUpdateV2(actor, deviceId, env) {
  const device = await getOwnedDevice(actor.userId, deviceId, env);
  if (!device) return json({ error: 'device_not_found' }, 404);
  const snapshot = await firmwareUpdateSnapshot(device, env);
  if (!snapshot) return json({ error: 'firmware_device_unavailable' }, 503);
  return json(snapshot);
}

export async function handleInstallFirmwareUpdateV2(
  actor,
  deviceId,
  body,
  env,
  requestId,
) {
  const expectedBuild = Number(body.build_number);
  if (!Number.isSafeInteger(expectedBuild) || expectedBuild <= 0) {
    return json({ error: 'firmware_build_invalid' }, 400);
  }
  if (body.download_preference != null
      && !Object.values(FIRMWARE_DOWNLOAD_PREFERENCES).includes(body.download_preference)) {
    return json({ error: 'firmware_download_preference_invalid' }, 400);
  }
  const downloadPreference = normalizeFirmwareDownloadPreference(body.download_preference);

  const device = await getOwnedDevice(actor.userId, deviceId, env);
  if (!device) return json({ error: 'device_not_found' }, 404);
  if (isSharedPrototypeReadOnly(device, env)) {
    return json({ error: 'shared_prototype_read_only' }, 403);
  }

  const controlDeviceId = resolveControlDeviceId(device, env);
  const controlDevice = controlDeviceId === device.device_id
    ? device
    : await env.DB.prepare('SELECT * FROM devices WHERE device_id = ?')
      .bind(controlDeviceId).first();
  if (!controlDevice) return json({ error: 'firmware_device_unavailable' }, 503);

  const release = await latestFirmwareRelease(controlDeviceId, env);
  if (!release) return json({ error: 'firmware_update_unavailable' }, 404);
  if (Number(release.build_number) !== expectedBuild) {
    return json({
      error: 'firmware_update_changed',
      release: summarizeFirmwareRelease(release),
    }, 409);
  }
  if (Number(controlDevice.firmware_build ?? 0) >= Number(release.build_number)) {
    return json(await firmwareUpdateSnapshot(device, env));
  }
  if (Number(controlDevice.firmware_build ?? 0) <= 0) {
    return json({ error: 'firmware_usb_bootstrap_required' }, 409);
  }
  if (!await activeDeviceCredential(controlDeviceId, env)) {
    return json({ error: 'device_credential_inactive' }, 409);
  }

  await env.DB.prepare(
    `INSERT INTO firmware_rollouts (release_uuid, device_id, status)
     VALUES (?, ?, 'pending')
     ON CONFLICT(release_uuid, device_id) DO UPDATE SET
       status = CASE
         WHEN firmware_rollouts.status IN ('failed', 'cancelled') THEN 'pending'
         ELSE firmware_rollouts.status
       END,
       failed_at = CASE
         WHEN firmware_rollouts.status IN ('failed', 'cancelled') THEN NULL
         ELSE firmware_rollouts.failed_at
       END,
       failure_reason = CASE
         WHEN firmware_rollouts.status IN ('failed', 'cancelled') THEN NULL
         ELSE firmware_rollouts.failure_reason
       END,
       updated_at = datetime('now')`
  ).bind(release.release_uuid, controlDeviceId).run();

  let command = await firmwareCommand(
    controlDeviceId,
    release.release_uuid,
    env,
    true,
  );
  let created = false;
  if (!command) {
    try {
      const queued = await queueDeviceCommand(controlDeviceId, 'OTA', env, {
        release_id: release.release_uuid,
        by_user_id: actor.userId,
        session_id: actor.sessionId,
        source: 'miniapp-v2',
        requested_via_device_id: deviceId,
        download_preference: downloadPreference,
      });
      command = { id: queued.id, status: queued.status };
      created = true;
    } catch (error) {
      command = await firmwareCommand(
        controlDeviceId,
        release.release_uuid,
        env,
        true,
      );
      if (!command) throw error;
    }
  }

  await env.DB.prepare(
    `UPDATE firmware_rollouts SET command_id = ?, status = 'pending',
       updated_at = datetime('now')
     WHERE release_uuid = ? AND device_id = ?`
  ).bind(command.id, release.release_uuid, controlDeviceId).run();

  if (created) {
    await audit(
      actor,
      requestId,
      'device.firmware.install',
      'firmware_release',
      release.release_uuid,
      env,
      {
        after: {
          device_id: deviceId,
          version: release.version,
          build_number: Number(release.build_number),
          download_preference: downloadPreference,
          status: 'queued',
        },
      },
    );
  }

  const snapshot = await firmwareUpdateSnapshot(device, env);
  return json(snapshot, 202);
}

export async function handleDeviceCommandV2(actor, deviceId, body, env, requestId) {
  const action = String(body.action ?? '').toUpperCase();
  if (!['ARM', 'DISARM'].includes(action)) {
    return json({ error: 'command_action_invalid' }, 400);
  }
  const device = await getOwnedDevice(actor.userId, deviceId, env);
  if (!device) return json({ error: 'device_not_found' }, 404);
  if (isSharedPrototypeReadOnly(device, env)) {
    return json({ error: 'shared_prototype_read_only' }, 403);
  }
  const controlDeviceId = resolveControlDeviceId(device, env);

  const command = await queueDeviceCommand(controlDeviceId, action, env, {
    by_user_id: actor.userId,
    session_id: actor.sessionId,
    source: 'miniapp-v2',
    requested_via_device_id: deviceId,
  });
  await logEvent(controlDeviceId, action, 'info', env, {
    payload: {
      commanded_by_user_id: actor.userId,
      source: 'miniapp-v2',
      requested_via_device_id: deviceId,
    },
  });
  await audit(actor, requestId, `device.command.${action.toLowerCase()}`, 'device', deviceId, env, {
    after: { action, status: 'queued' },
  });
  return json({
    command: {
      id: command.id,
      status: command.status,
      action,
      device_id: deviceId,
    },
  }, 202);
}

export async function handleGetDeviceCommandV2(actor, deviceId, commandId, env) {
  const device = await getOwnedDevice(actor.userId, deviceId, env);
  if (!device) return json({ error: 'device_not_found' }, 404);
  if (!Number.isSafeInteger(commandId) || commandId < 1) {
    return json({ error: 'command_id_invalid' }, 400);
  }
  const controlDeviceId = resolveControlDeviceId(device, env);
  const command = await env.DB.prepare(
    `SELECT id, device_id, command AS action, status, created_at, delivered_at,
            acknowledged_at, ack_status, payload_json
     FROM device_commands WHERE id = ? AND device_id = ?`
  ).bind(commandId, controlDeviceId).first();
  if (!command) return json({ error: 'command_not_found' }, 404);
  if (controlDeviceId !== deviceId) {
    let payload = {};
    try { payload = JSON.parse(command.payload_json ?? '{}'); } catch { /* invalid metadata is inaccessible */ }
    if (Number(payload.by_user_id) !== Number(actor.userId)
      || payload.requested_via_device_id !== deviceId) {
      return json({ error: 'command_not_found' }, 404);
    }
  }
  const { payload_json: _privatePayload, ...publicCommand } = command;
  return json({ command: { ...publicCommand, device_id: deviceId } });
}

export async function handleAcknowledgeGeofenceEventV2(actor, eventUuid, env, requestId) {
  const event = await env.DB.prepare(
    `SELECT g.event_uuid, g.acknowledged_at, d.device_id
     FROM geofence_events g
     JOIN devices d ON d.device_id = g.device_id
     WHERE g.event_uuid = ? AND d.owner_id = ?`
  ).bind(eventUuid, actor.userId).first();
  if (!event) return json({ error: 'geofence_event_not_found' }, 404);

  if (!event.acknowledged_at) {
    await env.DB.prepare(
      `UPDATE geofence_events
       SET acknowledged_by = ?, acknowledged_at = datetime('now')
       WHERE event_uuid = ? AND acknowledged_at IS NULL`
    ).bind(actor.userId, eventUuid).run();
    await audit(actor, requestId, 'geofence.event.acknowledge', 'geofence_event', eventUuid, env);
  }
  const updated = await env.DB.prepare(
    `SELECT event_uuid AS id, acknowledged_at
     FROM geofence_events WHERE event_uuid = ?`
  ).bind(eventUuid).first();
  return json({ event: updated });
}

export async function handleListZonesV2(actor, deviceId, env) {
  const device = await getOwnedDevice(actor.userId, deviceId, env);
  if (!device) return json({ error: 'device_not_found' }, 404);
  const zones = await env.DB.prepare(
    `SELECT z.*, s.state AS live_state, s.last_classification,
            s.last_distance_m, s.last_accuracy_m, s.last_sample_at
     FROM geofence_zones z
     LEFT JOIN device_zone_state s
       ON s.device_id = z.device_id AND s.zone_id = z.id
     WHERE z.device_id = ? AND z.status != 'archived'
     ORDER BY z.created_at DESC`
  ).bind(deviceId).all();
  return json({ zones: (zones.results ?? []).map(serializeZone) });
}

export async function handleCreateZoneV2(actor, deviceId, body, env, requestId) {
  const device = await getOwnedDevice(actor.userId, deviceId, env);
  if (!device) return json({ error: 'device_not_found' }, 404);

  const validated = validateCircleInput(body);
  if (validated.error) return json(validated, 400);
  const zone = validated.value;
  const zoneUuid = `gfz-${crypto.randomUUID()}`;
  const created = await env.DB.prepare(
    `INSERT INTO geofence_zones (
       device_id, label, anchor_lat, anchor_lon, radius_m, is_active,
       zone_uuid, zone_type, policy_type, status, version,
       exit_buffer_m, entry_buffer_m, confirm_samples, confirm_seconds,
       gps_accuracy_limit_m, schedule_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'circle', ?, ?, 1, ?, ?, ?, ?, ?, ?, datetime('now'))
     RETURNING *`
  ).bind(
    deviceId,
    zone.label,
    zone.anchorLat,
    zone.anchorLon,
    zone.radiusM,
    zone.status === 'active' ? 1 : 0,
    zoneUuid,
    zone.policy,
    zone.status,
    zone.exitBufferM,
    zone.entryBufferM,
    zone.confirmSamples,
    zone.confirmSeconds,
    zone.accuracyLimitM,
    zone.schedule ? JSON.stringify(zone.schedule) : null,
  ).first();

  await snapshotZone(created, actor, env);
  await audit(actor, requestId, 'zone.create', 'geofence_zone', zoneUuid, env, {
    after: serializeZone(created),
  });
  return json({ zone: serializeZone(created) }, 201);
}

export async function handleUpdateZoneV2(actor, zoneUuid, body, env, requestId) {
  const existing = await getOwnedZone(actor.userId, zoneUuid, env);
  if (!existing) return json({ error: 'zone_not_found' }, 404);
  if (!Number.isInteger(Number(body.version))) return json({ error: 'zone_version_required' }, 428);
  if (Number(body.version) !== Number(existing.version)) {
    return json({ error: 'zone_version_conflict', current: serializeZone(existing) }, 409);
  }

  const validated = validateCircleInput(body, existing);
  if (validated.error) return json(validated, 400);
  const zone = validated.value;
  const result = await env.DB.prepare(
    `UPDATE geofence_zones SET
       label = ?, anchor_lat = ?, anchor_lon = ?, radius_m = ?,
       is_active = ?, policy_type = ?, status = ?, version = version + 1,
       exit_buffer_m = ?, entry_buffer_m = ?, confirm_samples = ?,
       confirm_seconds = ?, gps_accuracy_limit_m = ?, schedule_json = ?,
       updated_at = datetime('now')
     WHERE zone_uuid = ? AND version = ?`
  ).bind(
    zone.label,
    zone.anchorLat,
    zone.anchorLon,
    zone.radiusM,
    zone.status === 'active' ? 1 : 0,
    zone.policy,
    zone.status,
    zone.exitBufferM,
    zone.entryBufferM,
    zone.confirmSamples,
    zone.confirmSeconds,
    zone.accuracyLimitM,
    zone.schedule ? JSON.stringify(zone.schedule) : null,
    zoneUuid,
    existing.version,
  ).run();
  if (!result.meta?.changes) return json({ error: 'zone_version_conflict' }, 409);

  const updated = await getOwnedZone(actor.userId, zoneUuid, env);
  await snapshotZone(updated, actor, env);
  await env.DB.prepare(
    `DELETE FROM device_zone_state WHERE device_id = ? AND zone_id = ?`
  ).bind(updated.device_id, updated.id).run();
  await audit(actor, requestId, 'zone.update', 'geofence_zone', zoneUuid, env, {
    before: serializeZone(existing),
    after: serializeZone(updated),
  });
  return json({ zone: serializeZone(updated) });
}

export async function handleArchiveZoneV2(actor, zoneUuid, body, env, requestId) {
  return handleUpdateZoneV2(actor, zoneUuid, {
    ...body,
    status: 'archived',
  }, env, requestId);
}

export async function handleListPlaceSuggestionsV2(actor, deviceId, env) {
  const device = await getOwnedDevice(actor.userId, deviceId, env);
  if (!device) return json({ error: 'device_not_found' }, 404);
  const progress = await refreshPlaceSuggestions(
    deviceId,
    resolveTelemetryDeviceId(device),
    env,
  );
  const suggestions = await env.DB.prepare(
    `SELECT * FROM place_suggestions
     WHERE device_id = ? AND status = 'pending'
     ORDER BY confidence DESC, last_seen_at DESC LIMIT 5`
  ).bind(deviceId).all();
  return json({
    suggestions: (suggestions.results ?? []).map(serializeSuggestion),
    progress,
  });
}

async function getOwnedSuggestion(actor, suggestionUuid, env) {
  return env.DB.prepare(
    `SELECT s.* FROM place_suggestions s
     JOIN devices d ON d.device_id = s.device_id
     WHERE s.suggestion_uuid = ? AND d.owner_id = ?`
  ).bind(suggestionUuid, actor.userId).first();
}

export async function handleAcceptPlaceSuggestionV2(actor, suggestionUuid, body, env, requestId) {
  const suggestion = await getOwnedSuggestion(actor, suggestionUuid, env);
  if (!suggestion) return json({ error: 'suggestion_not_found' }, 404);
  if (suggestion.status !== 'pending') return json({ error: 'suggestion_not_pending' }, 409);
  const validated = validateCircleInput({
    name: String(body.name ?? suggestion.suggested_name),
    status: 'active',
    policy: 'safe',
    geometry: {
      type: 'Circle',
      center: [Number(suggestion.center_lon), Number(suggestion.center_lat)],
      radius_m: Number(body.radius_m ?? suggestion.suggested_radius_m),
    },
  });
  if (validated.error) return json(validated, 400);
  const zone = validated.value;
  const zoneUuid = `gfz-${crypto.randomUUID()}`;
  const created = await env.DB.prepare(
    `INSERT INTO geofence_zones (
       device_id, label, anchor_lat, anchor_lon, radius_m, is_active,
       zone_uuid, zone_type, policy_type, status, version,
       exit_buffer_m, entry_buffer_m, confirm_samples, confirm_seconds,
       gps_accuracy_limit_m, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, 'circle', 'safe', 'active', 1,
               ?, ?, ?, ?, ?, datetime('now')) RETURNING *`
  ).bind(
    suggestion.device_id,
    zone.label,
    zone.anchorLat,
    zone.anchorLon,
    zone.radiusM,
    zoneUuid,
    zone.exitBufferM,
    zone.entryBufferM,
    zone.confirmSamples,
    zone.confirmSeconds,
    zone.accuracyLimitM,
  ).first();
  await snapshotZone(created, actor, env);
  await env.DB.prepare(
    `UPDATE place_suggestions
     SET status = 'accepted', accepted_zone_uuid = ?, updated_at = datetime('now')
     WHERE suggestion_uuid = ?`
  ).bind(zoneUuid, suggestionUuid).run();
  await audit(actor, requestId, 'place_suggestion.accept', 'place_suggestion', suggestionUuid, env, {
    after: { accepted_zone_uuid: zoneUuid },
  });
  return json({ zone: serializeZone(created), suggestion_status: 'accepted' }, 201);
}

export async function handleDismissPlaceSuggestionV2(actor, suggestionUuid, env, requestId) {
  const suggestion = await getOwnedSuggestion(actor, suggestionUuid, env);
  if (!suggestion) return json({ error: 'suggestion_not_found' }, 404);
  await env.DB.prepare(
    `UPDATE place_suggestions SET status = 'dismissed', updated_at = datetime('now')
     WHERE suggestion_uuid = ?`
  ).bind(suggestionUuid).run();
  await audit(actor, requestId, 'place_suggestion.dismiss', 'place_suggestion', suggestionUuid, env);
  return json({ status: 'dismissed' });
}
