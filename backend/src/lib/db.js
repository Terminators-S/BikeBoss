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
       telegram_handle = COALESCE(excluded.telegram_handle, users.telegram_handle),
       display_name = COALESCE(excluded.display_name, users.display_name),
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
    `SELECT t.*,
            (SELECT MAX(newest.received_at) FROM telemetry newest
             WHERE newest.device_id = t.device_id) AS last_received_at
     FROM telemetry t
     WHERE t.device_id = ?
     ORDER BY datetime(COALESCE(t.captured_at, t.received_at)) DESC, t.id DESC
     LIMIT 1`
  ).bind(deviceId).first();
}

export async function logEvent(deviceId, eventType, severity, env, { lat = null, lon = null, payload = null } = {}) {
  const result = await env.DB.prepare(
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
  return result.meta?.last_row_id ?? null;
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
  const result = await env.DB.prepare(
    `INSERT INTO device_commands (device_id, command, payload_json)
     VALUES (?, ?, ?)`
  ).bind(deviceId, command, payload ? JSON.stringify(payload) : null).run();
  return {
    id: Number(result.meta?.last_row_id),
    status: 'pending',
  };
}

/**
 * Device pulls pending commands (long-poll style on heartbeat).
 */
export async function pullPendingCommands(deviceId, env, {
  includeSecureConfiguration = true,
} = {}) {
  const secureFilter = includeSecureConfiguration ? '' : "AND command != 'WIFI_SYNC'";
  const res = await env.DB.prepare(
    `SELECT id, command, payload_json FROM device_commands
     WHERE device_id = ?
       AND (status = 'pending'
         OR (status = 'delivered' AND delivered_at < datetime('now', '-2 minutes')))
       ${secureFilter}
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

export async function acknowledgeDeviceCommands(deviceId, acknowledgements, env) {
  const items = Array.isArray(acknowledgements)
    ? acknowledgements.slice(0, 10)
    : [];
  for (const acknowledgement of items) {
    const commandId = Number(acknowledgement?.id);
    const status = String(acknowledgement?.status ?? '').toLowerCase();
    if (!Number.isSafeInteger(commandId) || !['applied', 'failed'].includes(status)) continue;
    const command = await env.DB.prepare(
      `SELECT command, payload_json FROM device_commands
       WHERE id = ? AND device_id = ? AND status = 'delivered'`
    ).bind(commandId, deviceId).first();
    if (!command) continue;

    await env.DB.prepare(
      `UPDATE device_commands SET
         status = 'acked',
         acknowledged_at = datetime('now'),
         ack_status = ?,
         ack_payload_json = ?
       WHERE id = ? AND device_id = ? AND status = 'delivered'`
    ).bind(
      status,
      JSON.stringify(acknowledgement?.details ?? {}),
      commandId,
      deviceId,
    ).run();

    if (status === 'applied' && command.command === 'WIFI_SYNC') {
      let revision = null;
      try {
        revision = Number(JSON.parse(command.payload_json ?? '{}').revision);
      } catch { /* invalid command metadata cannot advance the applied revision */ }
      if (Number.isSafeInteger(revision) && revision >= 0) {
        await env.DB.prepare(
          `UPDATE devices SET
             wifi_config_applied_revision = MAX(wifi_config_applied_revision, ?),
             updated_at = datetime('now')
           WHERE device_id = ?`
        ).bind(revision, deviceId).run();
      }
    }
    if (command.command === 'OTA') {
      let releaseId = '';
      try {
        releaseId = String(JSON.parse(command.payload_json ?? '{}').release_id ?? '');
      } catch { /* invalid metadata cannot update a rollout */ }
      if (releaseId) {
        const details = acknowledgement?.details ?? {};
        if (status === 'applied') {
          const installedBuild = Number(details.build_number);
          const installedVersion = String(details.version ?? '');
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE firmware_rollouts SET status = 'installed', installed_at = datetime('now'),
                 failure_reason = NULL, updated_at = datetime('now')
               WHERE release_uuid = ? AND device_id = ?`,
            ).bind(releaseId, deviceId),
            env.DB.prepare(
              `UPDATE devices SET
                 firmware_build = MAX(firmware_build, ?),
                 firmware_ver = CASE WHEN ? != '' THEN ? ELSE firmware_ver END,
                 updated_at = datetime('now') WHERE device_id = ?`,
            ).bind(Number.isSafeInteger(installedBuild) ? installedBuild : 0,
              installedVersion, installedVersion, deviceId),
          ]);
        } else {
          await env.DB.prepare(
            `UPDATE firmware_rollouts SET status = 'failed', failed_at = datetime('now'),
               failure_reason = ?, updated_at = datetime('now')
             WHERE release_uuid = ? AND device_id = ?`,
          ).bind(String(details.reason ?? 'device_rejected'), releaseId, deviceId).run();
        }
      }
    }
  }
}
