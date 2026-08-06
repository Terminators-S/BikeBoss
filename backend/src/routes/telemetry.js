/**
 * Telemetry ingestion handlers.
 */

import { checkGeofence, checkVanLift, checkHeartbeatTimeout } from '../lib/geofence.js';
import { reconstructTrip } from '../lib/trips.js';
import { getUserChatIdForDevice, logEvent, pullPendingCommands } from '../lib/db.js';
import { sendTelegramMessage } from '../lib/telegram.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function handleTelemetry(body, env) {
  const {
    device_id, arm_state, gps, imu, vbat,
    crash_stage, geofence_active,
    geofence_anchor_lat, geofence_anchor_lon,
  } = body;

  if (!device_id) {
    return json({ error: 'device_id required' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO telemetry (
       device_id, arm_state,
       gps_lat, gps_lon, gps_speed, gps_fix,
       imu_ax, imu_ay, imu_az, imu_gx, imu_gy, imu_gz, imu_atotal, imu_gtotal,
       vbat, crash_stage, geofence_active, geofence_anchor_lat, geofence_anchor_lon
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    geofence_anchor_lon ?? null
  ).run();

  // Side-effect checks (best-effort; don't fail ingestion)
  try {
    if (gps?.fix && gps?.lat != null && gps?.lon != null) {
      await checkGeofence(device_id, gps.lat, gps.lon, gps.speed ?? 0, env);
    }
    if (imu?.atotal != null) {
      await checkVanLift(device_id, imu.atotal, !!gps?.fix, env);
    }
    if (gps?.fix) {
      await reconstructTrip(device_id, env);
    }
  } catch (err) {
    console.error('telemetry side-effects error:', err);
  }

  // Device command downlink (device pulls on each heartbeat)
  const commands = await pullPendingCommands(device_id, env).catch(() => []);

  return json({
    status: 'ok',
    device_id,
    commands: commands.map((c) => ({ id: c.id, command: c.command, payload: c.payload_json ? JSON.parse(c.payload_json) : null })),
  });
}

export async function handleCrash(body, env) {
  const { device_id, gps, imu, timestamp } = body;

  if (!device_id) return json({ error: 'device_id required' }, 400);

  await logEvent(device_id, 'CRASH', 'critical', env, {
    lat: gps?.lat ?? null,
    lon: gps?.lon ?? null,
    payload: { imu, timestamp },
  });

  const chatId = await getUserChatIdForDevice(device_id, env);
  if (chatId) {
    const locationLink = (gps?.lat && gps?.lon)
      ? `\n📍 <a href="https://maps.google.com/?q=${gps.lat},${gps.lon}">Crash Location on Map</a>`
      : '\n⚠️ GPS location unavailable';

    await sendTelegramMessage(chatId, [
      '🆘 <b>CRASH DETECTED!</b>',
      '',
      `Device: <code>${device_id}</code>`,
      `Impact: ${imu?.atotal?.toFixed(1) || '?'} m/s²`,
      `Rotation: ${imu?.gtotal?.toFixed(2) || '?'} rad/s`,
      `Posture: Az=${imu?.az?.toFixed(1) || '?'} m/s²`,
      locationLink,
      '',
      '⚠️ <b>Emergency services may need to be contacted.</b>',
    ].join('\n'), env, { deviceId: device_id });
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
    await sendTelegramMessage(chatId, [
      '🔌 <b>POWER CUT ALERT!</b>',
      '',
      `Device: <code>${device_id}</code>`,
      `Battery: ${vbat?.toFixed(1) || '?'}V`,
      '',
      'The main motorcycle battery has been disconnected.',
      'The device is now running on its internal backup battery.',
      '⚠️ This may indicate tampering or theft.',
    ].join('\n'), env, { deviceId: device_id });
  }

  return json({ status: 'ok' });
}
