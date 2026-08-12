/**
 * JSON API handlers for the Mini App / dashboards.
 */

import {
  getDevice, latestTelemetry, getUserByTelegramId, getDevicesForUser,
  queueDeviceCommand, logEvent,
} from '../lib/db.js';
import { connectivityFromTelemetry } from '../lib/device-status.js';
import { isSharedPrototypeReadOnly, resolveControlDeviceId } from '../lib/device-alias.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function handleGetDeviceStatus(deviceId, env) {
  const device = await getDevice(deviceId, env);
  if (!device) return json({ error: 'device not found' }, 404);

  const latest = await latestTelemetry(deviceId, env);

  const recentEvents = await env.DB.prepare(
    `SELECT * FROM events WHERE device_id = ? ORDER BY created_at DESC LIMIT 10`
  ).bind(deviceId).all();

  const geofences = await env.DB.prepare(
    `SELECT * FROM geofence_zones WHERE device_id = ? AND is_active = 1`
  ).bind(deviceId).all();

  return json({
    device,
    latest_telemetry: latest,
    connectivity: connectivityFromTelemetry(
      latest,
      Number(env.HEARTBEAT_TIMEOUT_MS ?? 600000),
    ),
    recent_events: recentEvents.results || [],
    geofences: geofences.results || [],
  });
}

export async function handleGetTrips(deviceId, env) {
  const trips = await env.DB.prepare(
    `SELECT * FROM trips WHERE device_id = ? ORDER BY start_time DESC LIMIT 20`
  ).bind(deviceId).all();
  return json(trips.results || []);
}

export async function handleSetGeofence(body, env) {
  const { device_id, label, anchor_lat, anchor_lon, radius_m } = body;
  if (!device_id || anchor_lat == null || anchor_lon == null) {
    return json({ error: 'device_id, anchor_lat, anchor_lon required' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO geofence_zones (device_id, label, anchor_lat, anchor_lon, radius_m)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    device_id,
    label || 'Custom',
    anchor_lat,
    anchor_lon,
    radius_m ?? Number(env.GEOFENCE_DEFAULT_RADIUS_M ?? 100)
  ).run();

  return json({ status: 'ok' });
}

/**
 * GET /api/v1/user/:telegramId/language → { language: 'en' | 'km' | null }
 * Used by the Mini App to sync with the bot's language preference.
 */
export async function handleGetLanguage(telegramId, env) {
  const user = await env.DB.prepare(
    'SELECT language FROM users WHERE telegram_id = ?'
  ).bind(String(telegramId)).first();

  return json({ language: user?.language ?? null });
}

/**
 * POST /api/v1/user/language { telegram_id, language } — set preference.
 * Shared with the bot: changing in the app changes alerts too, and vice versa.
 */
export async function handleSetLanguage(body, env) {
  const { telegram_id, language } = body;
  if (!telegram_id || !['en', 'km'].includes(language)) {
    return json({ error: 'telegram_id and language (en|km) required' }, 400);
  }

  await env.DB.prepare(
    `UPDATE users SET language = ?, updated_at = datetime('now') WHERE telegram_id = ?`
  ).bind(language, String(telegram_id)).run();

  return json({ status: 'ok', language });
}

/**
 * POST /api/v1/user/register { telegram_id, display_name, handle }
 * Ensures the user row exists (mini app first-open without bot /start).
 */
export async function handleRegisterUser(body, env) {
  const { telegram_id, display_name, handle } = body;
  if (!telegram_id) return json({ error: 'telegram_id required' }, 400);

  await env.DB.prepare(
    `INSERT INTO users (telegram_id, telegram_handle, display_name)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       telegram_handle = COALESCE(excluded.telegram_handle, users.telegram_handle),
       display_name = COALESCE(excluded.display_name, users.display_name),
       updated_at = datetime('now')`
  ).bind(String(telegram_id), handle ?? null, display_name ?? null).run();

  return json({ status: 'ok' });
}

/**
 * GET /api/v1/me/:telegramId — everything the app shell needs in one call:
 * user profile, linked devices (with latest telemetry per device).
 */
export async function handleGetMe(telegramId, env) {
  const user = await getUserByTelegramId(telegramId, env);
  if (!user) return json({ user: null, devices: [] });

  const devices = await getDevicesForUser(telegramId, env);
  const withTelemetry = [];
  for (const d of devices) {
    const latest = await latestTelemetry(d.device_id, env);
    const geofences = await env.DB.prepare(
      'SELECT * FROM geofence_zones WHERE device_id = ? AND is_active = 1'
    ).bind(d.device_id).all();
    withTelemetry.push({ ...d, latest_telemetry: latest, geofences: geofences.results || [] });
  }

  return json({
    user: {
      telegram_id: user.telegram_id,
      display_name: user.display_name,
      telegram_handle: user.telegram_handle,
      language: user.language,
    },
    devices: withTelemetry,
  });
}

/**
 * POST /api/v1/device/:id/command { action: 'ARM' | 'DISARM', telegram_id }
 * Queues a command for the device; applied on next heartbeat.
 */
export async function handleDeviceCommand(deviceId, body, env) {
  const { action, telegram_id } = body;
  if (!['ARM', 'DISARM'].includes(action)) {
    return json({ error: "action must be 'ARM' or 'DISARM'" }, 400);
  }

  // Ownership check: the requesting Telegram user must own the device
  if (telegram_id) {
    const owned = await env.DB.prepare(
      `SELECT d.device_id FROM devices d
       JOIN users u ON d.owner_id = u.id
       WHERE d.device_id = ? AND u.telegram_id = ?`
    ).bind(deviceId, String(telegram_id)).first();
    if (!owned) return json({ error: 'device not linked to this account' }, 403);
  }

  const device = await getDevice(deviceId, env);
  if (!device) return json({ error: 'device not found' }, 404);
  if (isSharedPrototypeReadOnly(device, env)) {
    return json({ error: 'shared_prototype_read_only' }, 403);
  }
  const controlDeviceId = resolveControlDeviceId(device, env);

  await queueDeviceCommand(controlDeviceId, action, env, {
    by: telegram_id ?? 'miniapp',
    requested_via_device_id: deviceId,
  });
  await logEvent(controlDeviceId, action, 'info', env, {
    payload: {
      commanded_by: telegram_id ?? 'miniapp',
      source: 'miniapp',
      requested_via_device_id: deviceId,
    },
  });

  return json({ status: 'queued', action, device_id: deviceId });
}

/**
 * POST /api/v1/device/link { telegram_id, device_id }
 * Mini-app equivalent of the bot's /register command.
 */
export async function handleLinkDevice(body, env) {
  const { telegram_id } = body;
  const deviceId = (body.device_id || '').toUpperCase().trim();

  if (!telegram_id) return json({ error: 'telegram_id required' }, 400);
  if (!deviceId || !/^BB-[A-Z0-9]{4,}$/.test(deviceId)) {
    return json({ error: 'invalid_device_id' }, 400);
  }

  const user = await getUserByTelegramId(telegram_id, env);
  if (!user) return json({ error: 'user_not_found' }, 404);

  const device = await getDevice(deviceId, env);

  if (!device) {
    // Auto-provision: brand-new unit claimed by first user who registers it
    await env.DB.prepare(
      `INSERT INTO devices (device_id, owner_id) VALUES (?, ?)`
    ).bind(deviceId, user.id).run();
    return json({ status: 'linked', device_id: deviceId, provisioned: true });
  }

  if (device.owner_id) {
    if (device.owner_id === user.id) {
      return json({ status: 'already_mine', device_id: deviceId });
    }
    return json({ error: 'device_taken' }, 409);
  }

  await env.DB.prepare(
    `UPDATE devices SET owner_id = ?, updated_at = datetime('now') WHERE device_id = ?`
  ).bind(user.id, deviceId).run();

  return json({ status: 'linked', device_id: deviceId });
}

/**
 * POST /api/v1/geofence/here { device_id, telegram_id }
 * Anchors a geofence at the device's last known GPS fix (same as bot /geofence).
 */
export async function handleGeofenceHere(body, env) {
  const { device_id, telegram_id } = body;
  if (!device_id) return json({ error: 'device_id required' }, 400);

  if (telegram_id) {
    const owned = await env.DB.prepare(
      `SELECT d.device_id FROM devices d
       JOIN users u ON d.owner_id = u.id
       WHERE d.device_id = ? AND u.telegram_id = ?`
    ).bind(device_id, String(telegram_id)).first();
    if (!owned) return json({ error: 'device not linked to this account' }, 403);
  }

  const latest = await env.DB.prepare(
    `SELECT gps_lat, gps_lon FROM telemetry
     WHERE device_id = ? AND gps_fix = 1
     ORDER BY received_at DESC LIMIT 1`
  ).bind(device_id).first();

  if (!latest) return json({ error: 'no_gps_fix' }, 409);

  const radius = Number(env.GEOFENCE_DEFAULT_RADIUS_M ?? 100);

  await env.DB.prepare(
    `UPDATE geofence_zones SET is_active = 0 WHERE device_id = ? AND label = 'Current Location'`
  ).bind(device_id).run();

  await env.DB.prepare(
    `INSERT INTO geofence_zones (device_id, label, anchor_lat, anchor_lon, radius_m, is_active)
     VALUES (?, 'Current Location', ?, ?, ?, 1)`
  ).bind(device_id, latest.gps_lat, latest.gps_lon, radius).run();

  return json({ status: 'ok', lat: latest.gps_lat, lon: latest.gps_lon, radius_m: radius });
}

/**
 * GET /api/v1/activity/:telegramId — merged timeline for the Activity screen:
 * latest trips + latest events for the user's first device.
 */
export async function handleGetActivity(telegramId, env) {
  const devices = await getDevicesForUser(telegramId, env);
  const device = devices[0];
  if (!device) return json({ trips: [], events: [] });

  const [trips, events] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM trips WHERE device_id = ? ORDER BY start_time DESC LIMIT 20`
    ).bind(device.device_id).all(),
    env.DB.prepare(
      `SELECT * FROM events WHERE device_id = ? ORDER BY created_at DESC LIMIT 30`
    ).bind(device.device_id).all(),
  ]);

  return json({
    device_id: device.device_id,
    trips: trips.results || [],
    events: events.results || [],
  });
}
