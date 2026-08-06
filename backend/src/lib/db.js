/**
 * Shared D1 queries.
 */

export async function getUserByTelegramId(telegramId, env) {
  return env.DB.prepare(
    'SELECT * FROM users WHERE telegram_id = ?'
  ).bind(String(telegramId)).first();
}

export async function upsertUser({ telegramId, handle, displayName }, env) {
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, telegram_handle, display_name)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       telegram_handle = excluded.telegram_handle,
       updated_at = datetime('now')`
  ).bind(String(telegramId), handle ?? null, displayName ?? 'Rider').run();

  return getUserByTelegramId(telegramId, env);
}

export async function getDevicesForUser(telegramId, env) {
  const res = await env.DB.prepare(
    `SELECT d.* FROM devices d
     JOIN users u ON d.owner_id = u.id
     WHERE u.telegram_id = ? AND d.is_active = 1
     ORDER BY d.created_at`
  ).bind(String(telegramId)).all();
  return res.results || [];
}

export async function getDeviceForUser(telegramId, env) {
  const devices = await getDevicesForUser(telegramId, env);
  return devices[0] ?? null;
}

export async function getDevice(deviceId, env) {
  return env.DB.prepare(
    'SELECT * FROM devices WHERE device_id = ?'
  ).bind(deviceId).first();
}

export async function getUserChatIdForDevice(deviceId, env) {
  const row = await env.DB.prepare(
    `SELECT u.telegram_id FROM users u
     JOIN devices d ON d.owner_id = u.id
     WHERE d.device_id = ?`
  ).bind(deviceId).first();
  return row ? row.telegram_id : null;
}

export async function latestTelemetry(deviceId, env) {
  return env.DB.prepare(
    `SELECT * FROM telemetry WHERE device_id = ? ORDER BY received_at DESC LIMIT 1`
  ).bind(deviceId).first();
}

export async function logEvent(deviceId, eventType, severity, env, { lat = null, lon = null, payload = null } = {}) {
  await env.DB.prepare(
    `INSERT INTO events (device_id, event_type, severity, gps_lat, gps_lon, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    deviceId,
    eventType,
    severity,
    lat,
    lon,
    payload ? JSON.stringify(payload) : null
  ).run();
}

/**
 * Has an event of this type been logged within the last N minutes?
 * Used for alert deduplication.
 */
export async function recentEventExists(deviceId, eventType, withinMinutes, env) {
  const row = await env.DB.prepare(
    `SELECT id FROM events
     WHERE device_id = ? AND event_type = ?
     AND created_at > datetime('now', ?)
     LIMIT 1`
  ).bind(deviceId, eventType, `-${withinMinutes} minutes`).first();
  return !!row;
}

export async function queueDeviceCommand(deviceId, command, env, payload = null) {
  await env.DB.prepare(
    `INSERT INTO device_commands (device_id, command, payload_json)
     VALUES (?, ?, ?)`
  ).bind(deviceId, command, payload ? JSON.stringify(payload) : null).run();
}

/**
 * Device pulls pending commands (long-poll style on heartbeat).
 */
export async function pullPendingCommands(deviceId, env) {
  const res = await env.DB.prepare(
    `SELECT id, command, payload_json FROM device_commands
     WHERE device_id = ? AND status = 'pending'
     ORDER BY created_at LIMIT 5`
  ).bind(deviceId).all();

  const commands = res.results || [];
  if (commands.length > 0) {
    const ids = commands.map((c) => c.id);
    const placeholders = ids.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE device_commands SET status = 'delivered', delivered_at = datetime('now')
       WHERE id IN (${placeholders})`
    ).bind(...ids).run();
  }
  return commands;
}
