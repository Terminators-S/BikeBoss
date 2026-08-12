/**
 * Telemetry ingestion handlers.
 */

import { checkGeofence, checkVanLift } from '../lib/geofence.js';
import { processTripTelemetry } from '../lib/trips.js';
import {
  acknowledgeDeviceCommands,
  getUserChatIdForDevice,
  logEvent,
  pullPendingCommands,
  recentEventExists,
} from '../lib/db.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { getBotStrings, getLanguageForDevice } from '../lib/i18n.js';
import { verifyDeviceRequestSignature } from '../lib/auth.js';
import { hydrateFirmwareCommand } from '../lib/firmware-ota.js';
import { haversineDistance } from '../lib/geo.js';
import { buildEncryptedWifiSyncPayload } from '../lib/wifi-credentials.js';
import { parseDatabaseTimestamp } from '../lib/device-status.js';
import { hasStagingPrototypeAccess } from '../lib/device-alias.js';
import {
  assessGpsSample,
  gpsSampleFromRow,
  gpsSampleFromTelemetry,
} from '../lib/gps-sanity.js';
import {
  compactDeviceResponse,
  normalizeTelemetryBatch,
  normalizeTelemetryEnvelope,
} from '../lib/telemetry-codec.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function requestSequence(request) {
  const compactAuth = request.headers.get('X-BikeBoss-Auth');
  if (compactAuth) {
    const parts = compactAuth.split('.');
    if (parts.length === 4) return Number(parts[1]);
  }
  return Number(request.headers.get('X-BikeBoss-Sequence'));
}

function telemetryInsertStatement(body, env) {
  const {
    device_id, arm_state, gps, imu, vbat,
    crash_stage, geofence_active,
    geofence_anchor_lat, geofence_anchor_lon,
    message_id, sequence, captured_at,
    motion_state, ignition_state, owner_presence, uplink,
  } = body;

  return env.DB.prepare(
    `INSERT INTO telemetry (
       device_id, arm_state,
       gps_lat, gps_lon, gps_speed, gps_fix,
       imu_ax, imu_ay, imu_az, imu_gx, imu_gy, imu_gz, imu_atotal, imu_gtotal,
       vbat, crash_stage, geofence_active, geofence_anchor_lat, geofence_anchor_lon,
       message_id, sequence, captured_at, gps_accuracy_m, gps_hdop, gps_satellites,
       gps_heading, gps_altitude_m, gps_source, motion_state, ignition_state,
       owner_presence_connected, owner_presence_authenticated,
       owner_presence_age_s, owner_presence_confidence,
       uplink_type, uplink_signal_dbm, uplink_generation, uplink_label,
       uplink_profile_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    device_id,
    arm_state ?? 0,
    gps?.lat ?? null,
    gps?.lon ?? null,
    gps?.speed ?? null,
    gps?.fix ? 1 : 0,
    imu?.ax ?? null,
    imu?.ay ?? null,
    imu?.az ?? null,
    imu?.gx ?? null,
    imu?.gy ?? null,
    imu?.gz ?? null,
    imu?.atotal ?? null,
    imu?.gtotal ?? null,
    vbat ?? null,
    crash_stage ?? 0,
    geofence_active ? 1 : 0,
    geofence_anchor_lat ?? null,
    geofence_anchor_lon ?? null,
    message_id ?? null,
    sequence ?? null,
    captured_at ?? null,
    gps?.accuracy_m ?? null,
    gps?.hdop ?? null,
    gps?.satellites ?? null,
    gps?.heading ?? null,
    gps?.altitude_m ?? null,
    gps?.source ?? null,
    motion_state ?? null,
    ignition_state == null ? null : (ignition_state ? 1 : 0),
    owner_presence?.connected == null ? null : (owner_presence.connected ? 1 : 0),
    owner_presence?.authenticated == null ? null : (owner_presence.authenticated ? 1 : 0),
    owner_presence?.age_seconds ?? null,
    owner_presence?.confidence ?? null,
    uplink?.type ?? null,
    uplink?.signal_dbm ?? null,
    uplink?.generation ?? null,
    uplink?.label ?? null,
    uplink?.profile_id ?? null,
  );
}

async function latestAcceptedGpsSample(deviceId, env) {
  const row = await env.DB.prepare(
    `SELECT gps_lat, gps_lon, gps_accuracy_m, gps_hdop, gps_satellites,
            captured_at, received_at
     FROM telemetry
     WHERE device_id = ? AND gps_fix = 1
       AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
     ORDER BY datetime(COALESCE(captured_at, received_at)) DESC, id DESC
     LIMIT 1`
  ).bind(deviceId).first();
  return gpsSampleFromRow(row);
}

async function recentStationaryGpsSamples(deviceId, env) {
  const rows = await env.DB.prepare(
    `SELECT gps_lat, gps_lon, gps_speed, gps_accuracy_m, gps_hdop,
            gps_satellites, motion_state, captured_at, received_at
     FROM telemetry
     WHERE device_id = ? AND gps_fix = 1
       AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
       AND motion_state = 'stationary'
     ORDER BY datetime(COALESCE(captured_at, received_at)) DESC, id DESC
     LIMIT 8`
  ).bind(deviceId).all();
  return (rows.results ?? []).map(gpsSampleFromRow).filter(Boolean).reverse();
}

async function loadGpsContext(deviceId, env) {
  const [previous, stationaryHistory] = await Promise.all([
    latestAcceptedGpsSample(deviceId, env),
    recentStationaryGpsSamples(deviceId, env),
  ]);
  return { previous, stationaryHistory };
}

function rejectTelemetryGps(body, assessment) {
  if (!body?.gps?.fix) return;
  body.gps = { ...body.gps, fix: false, speed: 0, speed_m_s: 0 };
  console.warn(JSON.stringify({
    message: 'gps_sample_rejected',
    device_id: body.device_id,
    sequence: body.sequence ?? null,
    captured_at: body.captured_at ?? null,
    reason: assessment.reason,
    distance_m: assessment.distanceM == null ? null : Math.round(assessment.distanceM),
    allowed_distance_m: assessment.allowedDistanceM == null
      ? null : Math.round(assessment.allowedDistanceM),
  }));
}

async function sanitizeTelemetryGps(body, env, context = undefined) {
  const state = context === undefined
    ? await loadGpsContext(body.device_id, env)
    : context;
  if (!body?.gps?.fix) return state;
  const reference = state.previous;
  const sample = gpsSampleFromTelemetry(body);
  const assessment = assessGpsSample(sample, reference, {
    stationaryHistory: state.stationaryHistory,
  });
  if (!assessment.ok) {
    rejectTelemetryGps(body, assessment);
    return state;
  }
  state.previous = sample;
  if (sample.motionState === 'stationary' && Number(sample.speedKmh ?? 0) <= 2) {
    state.stationaryHistory.push(sample);
    state.stationaryHistory = state.stationaryHistory.slice(-8);
  }
  return state;
}

async function resolveAndObserveWifiProfile(body, env) {
  const profileId = body.uplink?.type === 'wifi' ? body.uplink?.profile_id : null;
  if (!profileId) return;
  const row = await env.DB.prepare(
    `SELECT profile_uuid, label, last_connected_at, learned_lat, learned_lon,
            learned_radius_m, observation_count
     FROM wifi_profiles
     WHERE profile_uuid = ? AND device_id = ? AND status = 'active'`
  ).bind(profileId, body.device_id).first();
  if (!row) {
    body.uplink.profile_id = null;
    body.uplink.label = null;
    return;
  }

  // The cloud owns the friendly alias. The tracker never gets to overwrite it.
  body.uplink.label = row.label;
  const previousMs = parseDatabaseTimestamp(row.last_connected_at);
  const sampledAtMs = Date.parse(body.captured_at ?? '') || Date.now();
  const addObservation = body.gps?.fix
    && Number.isFinite(Number(body.gps?.lat))
    && Number.isFinite(Number(body.gps?.lon))
    && (!Number.isFinite(previousMs) || sampledAtMs - previousMs >= 10 * 60 * 1000);

  if (!addObservation) {
    await env.DB.prepare(
      `UPDATE wifi_profiles SET last_connected_at = ?, updated_at = datetime('now')
       WHERE profile_uuid = ? AND device_id = ?`
    ).bind(body.captured_at ?? new Date().toISOString(), profileId, body.device_id).run();
    return;
  }

  const lat = Number(body.gps.lat);
  const lon = Number(body.gps.lon);
  const count = Number(row.observation_count ?? 0);
  const previousLat = row.learned_lat == null ? lat : Number(row.learned_lat);
  const previousLon = row.learned_lon == null ? lon : Number(row.learned_lon);
  const nextCount = count + 1;
  const learnedLat = ((previousLat * count) + lat) / nextCount;
  const learnedLon = ((previousLon * count) + lon) / nextCount;
  const distanceM = count === 0 ? 0 : haversineDistance(previousLat, previousLon, lat, lon);
  const learnedRadiusM = Math.min(2_000, Math.max(
    Number(row.learned_radius_m ?? 0),
    distanceM + Number(body.gps.accuracy_m ?? 15),
  ));
  await env.DB.prepare(
    `UPDATE wifi_profiles SET
       last_connected_at = ?, success_count = success_count + 1,
       learned_lat = ?, learned_lon = ?, learned_radius_m = ?,
       observation_count = ?, updated_at = datetime('now')
     WHERE profile_uuid = ? AND device_id = ?`
  ).bind(
    body.captured_at ?? new Date().toISOString(),
    learnedLat,
    learnedLon,
    learnedRadiusM,
    nextCount,
    profileId,
    body.device_id,
  ).run();
}

async function runTelemetrySideEffects(body, env) {
  const {
    device_id, gps, imu, captured_at, message_id, owner_presence,
  } = body;
  // Side-effect checks (best-effort; don't fail ingestion)
  try {
    if (gps?.fix && gps?.lat != null && gps?.lon != null) {
      const geofenceSample = {
        fix: true,
        lat: Number(gps.lat),
        lon: Number(gps.lon),
        speedKmh: Number(gps.speed ?? 0),
        accuracyM: gps.accuracy_m == null ? null : Number(gps.accuracy_m),
        capturedAt: captured_at ?? null,
        messageId: message_id ?? null,
        ownerPresence: owner_presence ?? null,
      };
      await checkGeofence(device_id, geofenceSample, env);

      if (env.ENVIRONMENT === 'staging') {
        const aliases = await env.DB.prepare(
          `SELECT * FROM devices
           WHERE telemetry_source_device_id = ?
             AND owner_id IS NOT NULL AND is_active = 1`
        ).bind(device_id).all();
        for (const alias of aliases.results ?? []) {
          if (!hasStagingPrototypeAccess(alias, env)) continue;
          try {
            await checkGeofence(alias.device_id, {
              ...geofenceSample,
              ownerPresence: null,
            }, env);
          } catch (err) {
            console.error(JSON.stringify({
              message: 'alias_geofence_check_failed',
              device_id: alias.device_id,
              error: err instanceof Error ? err.message : String(err),
            }));
          }
        }
      }
    }
    if (imu?.atotal != null) {
      await checkVanLift(device_id, imu, !!gps?.fix, env);
    }
  } catch (err) {
    console.error(JSON.stringify({
      message: 'telemetry_side_effects_failed',
      device_id,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

function insertedTelemetryId(result) {
  const id = Number(result?.meta?.last_row_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function runTripProcessing(body, insertResult, env) {
  if (!body?.gps?.fix) return;
  try {
    await processTripTelemetry(body, insertedTelemetryId(insertResult), env);
  } catch (error) {
    console.error(JSON.stringify({
      message: 'telemetry_trip_processing_failed',
      device_id: body.device_id,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function compactResponseFor(deviceId, sequence, env) {
  const commands = await pullPendingCommands(deviceId, env).catch(() => []);
  const hydrated = [];
  for (const command of commands) {
    if (command.command === 'OTA') {
      hydrated.push(await hydrateFirmwareCommand(command, deviceId, env));
      continue;
    }
    if (command.command !== 'WIFI_SYNC') {
      hydrated.push(command);
      continue;
    }
    let revision = 0;
    try { revision = Number(JSON.parse(command.payload_json ?? '{}').revision ?? 0); } catch { /* retryable */ }
    const payload = await buildEncryptedWifiSyncPayload(deviceId, revision, env);
    hydrated.push({ ...command, payload_json: JSON.stringify(payload) });
  }
  return json(compactDeviceResponse(sequence, hydrated));
}

async function runTelemetryBatchSideEffects(samples, env) {
  for (const sample of samples) {
    await runTelemetrySideEffects(sample, env);
  }
}

export async function handleTelemetry(body, env) {
  if (!body?.device_id) {
    return json({ error: 'device_id required' }, 400);
  }

  await sanitizeTelemetryGps(body, env);
  const insertResult = await telemetryInsertStatement(body, env).run();
  await runTripProcessing(body, insertResult, env);
  await runTelemetrySideEffects(body, env);

  // Device command downlink (device pulls on each heartbeat)
  const commands = await pullPendingCommands(body.device_id, env, {
    includeSecureConfiguration: false,
  }).catch(() => []);

  return json({
    status: 'ok',
    device_id: body.device_id,
    commands: commands.map((command) => {
      let payload = null;
      if (command.payload_json) {
        try {
          payload = JSON.parse(command.payload_json);
        } catch {
          payload = null;
        }
      }
      return { id: command.id, command: command.command, payload };
    }),
  });
}

/**
 * Signed production telemetry endpoint. The existing v1 route remains during
 * firmware migration, but all new firmware should use this contract.
 */
export async function handleTelemetryV2(request, rawBody, body, env, ctx = null) {
  const normalized = normalizeTelemetryEnvelope(body);
  if (!normalized.ok) return json({ error: normalized.error }, 400);
  const telemetry = normalized.value;
  const deviceId = telemetry.device_id;
  if (requestSequence(request) !== telemetry.sequence) {
    return json({ error: 'sequence_mismatch' }, 400);
  }

  const authenticated = await verifyDeviceRequestSignature(request, rawBody, deviceId, env);
  if (!authenticated.ok) {
    const status = authenticated.error === 'device_replay' ? 409 : 401;
    return json({ error: authenticated.error }, status);
  }

  try {
    await sanitizeTelemetryGps(telemetry, env);
    await resolveAndObserveWifiProfile(telemetry, env);
    const insertResult = await telemetryInsertStatement(telemetry, env).run();
    await runTripProcessing(telemetry, insertResult, env);
    if (telemetry.firmware) {
      await env.DB.prepare(
        `UPDATE devices SET firmware_build = MAX(firmware_build, ?), firmware_ver = ?,
           updated_at = datetime('now') WHERE device_id = ?`,
      ).bind(
        telemetry.firmware.build_number,
        telemetry.firmware.version,
        deviceId,
      ).run();
    }
    await acknowledgeDeviceCommands(deviceId, telemetry.command_acks, env);
    const sideEffects = runTelemetrySideEffects(telemetry, env);
    if (ctx) ctx.waitUntil(sideEffects);
    else await sideEffects;
    return compactResponseFor(deviceId, telemetry.sequence, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('device_sequence_rejected')
        || message.includes('UNIQUE constraint failed: telemetry.message_id')) {
      return json({ error: 'device_replay' }, 409);
    }
    throw error;
  }
}

/** Signed, bounded offline resend. Samples must be oldest-to-newest. */
export async function handleTelemetryBatchV2(request, rawBody, body, env, ctx = null) {
  const normalized = normalizeTelemetryBatch(body);
  if (!normalized.ok) return json({ error: normalized.error }, 400);
  if (requestSequence(request) !== normalized.sequence) {
    return json({ error: 'sequence_mismatch' }, 400);
  }

  const authenticated = await verifyDeviceRequestSignature(
    request,
    rawBody,
    normalized.deviceId,
    env,
  );
  if (!authenticated.ok) {
    const status = authenticated.error === 'device_replay' ? 409 : 401;
    return json({ error: authenticated.error }, status);
  }

  try {
    // A device can reboot after D1 commits but before SPIFFS removes the sent
    // lines. Skip that already-durable prefix and atomically insert the rest.
    const newSamples = normalized.samples.filter(
      (sample) => sample.sequence > authenticated.lastSequence,
    );
    let insertResults = [];
    if (newSamples.length > 0) {
      let gpsContext = await loadGpsContext(normalized.deviceId, env);
      for (const sample of newSamples) {
        gpsContext = await sanitizeTelemetryGps(sample, env, gpsContext);
      }
      for (const sample of newSamples) await resolveAndObserveWifiProfile(sample, env);
      insertResults = await env.DB.batch(
        newSamples.map((sample) => telemetryInsertStatement(sample, env)),
      );
      for (let index = 0; index < newSamples.length; index += 1) {
        await runTripProcessing(newSamples[index], insertResults[index], env);
      }
    }

    const acknowledgements = normalized.samples
      .flatMap((sample) => sample.command_acks ?? [])
      .slice(-10);
    await acknowledgeDeviceCommands(normalized.deviceId, acknowledgements, env);

    const sideEffects = runTelemetryBatchSideEffects(
      newSamples,
      env,
    );
    if (ctx) ctx.waitUntil(sideEffects);
    else await sideEffects;

    return compactResponseFor(normalized.deviceId, normalized.sequence, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('device_sequence_rejected')
        || message.includes('UNIQUE constraint failed: telemetry.message_id')) {
      return json({ error: 'device_replay' }, 409);
    }
    throw error;
  }
}

export async function handleCrash(body, env) {
  const { device_id, gps, imu, timestamp } = body;

  if (!device_id) return json({ error: 'device_id required' }, 400);

  // Older firmware held CONFIRMED indefinitely and retried the alert every
  // ten seconds. Keep ingestion idempotent enough to protect the rider from a
  // notification storm while the corrected firmware rolls out.
  if (await recentEventExists(device_id, 'CRASH', 1, env)) {
    return json({ status: 'ok', alert: 'deduplicated' });
  }

  await logEvent(device_id, 'CRASH', 'critical', env, {
    lat: gps?.lat ?? null,
    lon: gps?.lon ?? null,
    payload: { imu, timestamp },
  });

  const chatId = await getUserChatIdForDevice(device_id, env);
  if (chatId) {
    const locationLink = (gps?.lat && gps?.lon)
      ? `📍 <a href="https://maps.google.com/?q=${gps.lat},${gps.lon}">Crash Location on Map</a>`
      : '⚠️ GPS location unavailable';

    const s = getBotStrings(await getLanguageForDevice(device_id, env));
    await sendTelegramMessage(chatId, s.crash({
      deviceId: device_id,
      impact: (imu?.impact_peak ?? imu?.atotal)?.toFixed(1),
      rotation: (imu?.rotation_peak ?? imu?.gtotal)?.toFixed(2),
      az: (imu?.upright_projection ?? imu?.az)?.toFixed(1),
      locationLink,
    }), env, { deviceId: device_id });
  }

  return json({ status: 'ok', alert: 'dispatched' });
}

export async function handlePowerCutAlert(body, env) {
  const { device_id, vbat, timestamp } = body;
  if (!device_id) return json({ error: 'device_id required' }, 400);

  await logEvent(device_id, 'POWER_CUT', 'critical', env, {
    payload: { vbat, timestamp },
  });

  const chatId = await getUserChatIdForDevice(device_id, env);
  if (chatId) {
    const s = getBotStrings(await getLanguageForDevice(device_id, env));
    await sendTelegramMessage(chatId, s.powerCut({
      deviceId: device_id,
      vbat: vbat?.toFixed(1),
    }), env, { deviceId: device_id });
  }

  return json({ status: 'ok' });
}
