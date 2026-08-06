/**
 * Geofence engine + van-lift + heartbeat timeout checks.
 */

import { haversineDistance } from './geo.js';
import { sendTelegramMessage } from './telegram.js';
import { logEvent, getUserChatIdForDevice, recentEventExists } from './db.js';
import { MOTION_THRESHOLD } from './imu.js';
import { getBotStrings, getLanguageForDevice } from './i18n.js';

export const GEOFENCE_DEFAULT_RADIUS_M = 100;
export const GEOFENCE_MIN_SPEED_KMH = 0.5;

/**
 * Check a telemetry packet against active geofence zones.
 * Returns breach info or null.
 */
export async function checkGeofence(deviceId, lat, lon, speed, env) {
  const zones = await env.DB.prepare(
    `SELECT * FROM geofence_zones WHERE device_id = ? AND is_active = 1`
  ).bind(deviceId).all();

  if (!zones.results || zones.results.length === 0) return null;

  for (const zone of zones.results) {
    const distance = haversineDistance(zone.anchor_lat, zone.anchor_lon, lat, lon);

    if (distance > zone.radius_m && speed >= GEOFENCE_MIN_SPEED_KMH) {
      // Deduplicate: one breach alert per 10 minutes per zone
      if (await recentEventExists(deviceId, 'GEOFENCE_BREACH', 10, env)) continue;

      await logEvent(deviceId, 'GEOFENCE_BREACH', 'warning', env, {
        lat,
        lon,
        payload: {
          zone_label: zone.label,
          distance_m: distance,
          radius_m: zone.radius_m,
          speed_kmh: speed,
        },
      });

      const chatId = await getUserChatIdForDevice(deviceId, env);
      if (chatId) {
        const s = getBotStrings(await getLanguageForDevice(deviceId, env));
        await sendTelegramMessage(chatId, s.geofenceBreach({
          deviceId,
          zone: zone.label,
          distance: distance.toFixed(0),
          radius: zone.radius_m,
          speed: speed.toFixed(1),
          locationLink: `📍 <a href="https://maps.google.com/?q=${lat},${lon}">View on Map</a>`,
        }), env, { deviceId });
      }

      return { breached: true, zone: zone.label, distance };
    }
  }

  return null;
}

/**
 * Van-lift detection: motion without GPS fix.
 */
export async function checkVanLift(deviceId, atotal, gpsFix, env) {
  if (gpsFix || atotal == null || atotal <= MOTION_THRESHOLD) return false;

  if (await recentEventExists(deviceId, 'MOTION_SIGNAL_LOSS', 5, env)) return false;

  await logEvent(deviceId, 'MOTION_SIGNAL_LOSS', 'critical', env, {
    payload: { atotal, reason: 'Possible van-lift theft' },
  });

  const chatId = await getUserChatIdForDevice(deviceId, env);
  if (chatId) {
    const s = getBotStrings(await getLanguageForDevice(deviceId, env));
    await sendTelegramMessage(chatId, s.vanLift({ deviceId }), env, { deviceId });
  }

  return true;
}

/**
 * Heartbeat timeout: armed device silent > HEARTBEAT_TIMEOUT_MS.
 */
export async function checkHeartbeatTimeout(deviceId, env) {
  const timeoutMs = Number(env.HEARTBEAT_TIMEOUT_MS ?? 600000);

  const latest = await env.DB.prepare(
    `SELECT received_at, arm_state FROM telemetry
     WHERE device_id = ? ORDER BY received_at DESC LIMIT 1`
  ).bind(deviceId).first();

  if (!latest) return;

  const lastSeen = new Date(latest.received_at + 'Z').getTime();
  const elapsed = Date.now() - lastSeen;

  if (elapsed <= timeoutMs || latest.arm_state !== 1) return;
  if (await recentEventExists(deviceId, 'HEARTBEAT_TIMEOUT', 30, env)) return;

  await logEvent(deviceId, 'HEARTBEAT_TIMEOUT', 'warning', env, {
    payload: { elapsed_ms: elapsed },
  });

  const chatId = await getUserChatIdForDevice(deviceId, env);
  if (chatId) {
    const s = getBotStrings(await getLanguageForDevice(deviceId, env));
    await sendTelegramMessage(chatId, s.heartbeatTimeout({
      deviceId,
      lastSeen: latest.received_at,
    }), env, { deviceId });
  }
}
