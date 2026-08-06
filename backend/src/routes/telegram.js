/**
 * Telegram Bot webhook handler — commands + inline callbacks.
 */

import { sendTelegramMessage, answerCallbackQuery } from '../lib/telegram.js';
import {
  upsertUser, getDeviceForUser, getDevice, latestTelemetry,
  logEvent, queueDeviceCommand,
} from '../lib/db.js';
import { createInvoice } from '../lib/payments.js';

const ok = () => new Response('OK', { status: 200 });

const ARM_LABELS = ['🟢 Disarmed', '🔴 Armed', '🟡 Pending Unlock'];

const HELP_TEXT = [
  '🏍️ <b>BikeBoss Commands</b>',
  '',
  '/register <code>BB-xxxxxxxx</code> — Link your device',
  '/status — View bike status',
  '/arm — Arm immobilizer',
  '/disarm — Disarm immobilizer',
  '/locate — Get GPS location',
  '/geofence — Set geofence anchor',
  '/trips — Recent trip history',
  '/subscribe — Manage subscription',
  '/help — Show this help',
].join('\n');

export async function handleTelegramWebhook(body, env) {
  const msg = body.message;
  const cb = body.callback_query;

  if (cb) {
    await answerCallbackQuery(cb.id, env);
    return handleCallback(cb, env);
  }
  if (!msg?.text) return ok();

  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  const text = msg.text.trim();

  // Always upsert user on any interaction
  await upsertUser({
    telegramId,
    handle: msg.from.username ?? null,
    displayName: msg.from.first_name ?? 'Rider',
  }, env);

  let reply = null;

  if (text.startsWith('/start')) {
    reply = [
      '🏍️ <b>Welcome to BikeBoss!</b>',
      '',
      'Your motorcycle security & safety companion.',
      '',
      'First, link your device:',
      '/register <code>BB-00000001</code>',
      '',
      HELP_TEXT,
    ].join('\n');
  } else if (text.startsWith('/register')) {
    reply = await cmdRegister(text, telegramId, env);
  } else if (text.startsWith('/status')) {
    reply = await cmdStatus(telegramId, env);
  } else if (text.startsWith('/locate')) {
    reply = await cmdLocate(telegramId, env);
  } else if (text.startsWith('/arm')) {
    reply = await cmdArmDisarm(telegramId, 'ARM', env);
  } else if (text.startsWith('/disarm')) {
    reply = await cmdArmDisarm(telegramId, 'DISARM', env);
  } else if (text.startsWith('/geofence')) {
    reply = await cmdGeofence(telegramId, env);
  } else if (text.startsWith('/trips')) {
    reply = await cmdTrips(telegramId, env);
  } else if (text.startsWith('/subscribe')) {
    return cmdSubscribe(chatId, telegramId, env);
  } else if (text.startsWith('/help')) {
    reply = HELP_TEXT;
  } else {
    reply = 'Unknown command. Type /help for available commands.';
  }

  if (reply) {
    await sendTelegramMessage(chatId, reply, env);
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdRegister(text, telegramId, env) {
  const parts = text.split(/\s+/);
  const deviceId = parts[1]?.toUpperCase();

  if (!deviceId || !/^BB-[A-Z0-9]{4,}$/.test(deviceId)) {
    return [
      '⚠️ Usage: /register <code>BB-xxxxxxxx</code>',
      'The device ID is printed on your BikeBoss unit label.',
    ].join('\n');
  }

  const device = await getDevice(deviceId, env);

  if (!device) {
    // Auto-provision: register unknown device and claim it
    const user = await upsertUser({ telegramId }, env);
    await env.DB.prepare(
      `INSERT INTO devices (device_id, owner_id) VALUES (?, ?)`
    ).bind(deviceId, user.id).run();

    return [
      '✅ <b>Device registered & linked!</b>',
      '',
      `Device: <code>${deviceId}</code>`,
      'This unit was auto-provisioned. It can now send telemetry.',
      'Try /status once the device comes online.',
    ].join('\n');
  }

  if (device.owner_id) {
    const owner = await env.DB.prepare(
      'SELECT telegram_id FROM users WHERE id = ?'
    ).bind(device.owner_id).first();
    if (owner?.telegram_id === telegramId) {
      return `ℹ️ <code>${deviceId}</code> is already linked to your account.`;
    }
    return `⚠️ <code>${deviceId}</code> is already linked to another account. Contact support to transfer.`;
  }

  const user = await upsertUser({ telegramId }, env);
  await env.DB.prepare(
    `UPDATE devices SET owner_id = ?, updated_at = datetime('now') WHERE device_id = ?`
  ).bind(user.id, deviceId).run();

  return [
    '✅ <b>Device linked!</b>',
    '',
    `Device: <code>${deviceId}</code>`,
    'Try /status to see live data.',
  ].join('\n');
}

async function cmdStatus(telegramId, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) return '⚠️ No device linked. Use /register <code>BB-xxxxxxxx</code>.';

  const latest = await latestTelemetry(device.device_id, env);
  const lastEvent = await env.DB.prepare(
    `SELECT event_type, created_at FROM events WHERE device_id = ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(device.device_id).first();

  return [
    `🏍️ <b>${device.vehicle_model || 'Your Bike'}</b>`,
    `📟 Device: <code>${device.device_id}</code>`,
    '',
    `🔐 Status: ${ARM_LABELS[latest?.arm_state ?? 0]}`,
    `📡 GPS: ${latest?.gps_fix ? '✅ Fixed' : '❌ No Fix'}`,
    `📍 Last seen: ${latest?.received_at || 'never'}`,
    `🔋 Battery: ${latest?.vbat != null ? latest.vbat.toFixed(1) + 'V' : 'N/A'}`,
    `🏁 Speed: ${latest?.gps_speed != null ? latest.gps_speed.toFixed(1) + ' km/h' : '0 km/h'}`,
    '',
    `📅 Sub expires: ${device.subscription_expiry || 'N/A'}`,
    lastEvent ? `\n⚠️ Last alert: <b>${lastEvent.event_type}</b> (${lastEvent.created_at})` : '',
  ].join('\n');
}

async function cmdLocate(telegramId, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) return '⚠️ No device linked.';

  const latest = await latestTelemetry(device.device_id, env);
  if (!latest?.gps_fix || latest.gps_lat == null) {
    return '⚠️ No GPS fix available right now. Try again in a moment.';
  }

  return [
    '📍 <b>Live Location</b>',
    '',
    `🌐 Lat: <code>${latest.gps_lat.toFixed(6)}</code>`,
    `🌐 Lon: <code>${latest.gps_lon.toFixed(6)}</code>`,
    `🏁 Speed: ${(latest.gps_speed ?? 0).toFixed(1)} km/h`,
    `🕐 Updated: ${latest.received_at}`,
    '',
    `🗺️ <a href="https://maps.google.com/?q=${latest.gps_lat},${latest.gps_lon}">Open in Google Maps</a>`,
  ].join('\n');
}

async function cmdArmDisarm(telegramId, action, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) return '⚠️ No device linked.';

  await queueDeviceCommand(device.device_id, action, env, { by: telegramId });
  await logEvent(device.device_id, action, 'info', env, {
    payload: { commanded_by: telegramId },
  });

  return `✅ <b>${action}</b> command queued for <code>${device.device_id}</code>. It applies on the next device heartbeat.`;
}

async function cmdGeofence(telegramId, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) return '⚠️ No device linked.';

  const latest = await env.DB.prepare(
    `SELECT gps_lat, gps_lon FROM telemetry
     WHERE device_id = ? AND gps_fix = 1
     ORDER BY received_at DESC LIMIT 1`
  ).bind(device.device_id).first();

  if (!latest) return '⚠️ No GPS fix available. Cannot set geofence.';

  const radius = Number(env.GEOFENCE_DEFAULT_RADIUS_M ?? 100);

  await env.DB.prepare(
    `UPDATE geofence_zones SET is_active = 0 WHERE device_id = ? AND label = 'Current Location'`
  ).bind(device.device_id).run();

  await env.DB.prepare(
    `INSERT INTO geofence_zones (device_id, label, anchor_lat, anchor_lon, radius_m, is_active)
     VALUES (?, 'Current Location', ?, ?, ?, 1)`
  ).bind(device.device_id, latest.gps_lat, latest.gps_lon, radius).run();

  return [
    '📍 <b>Geofence Set</b>',
    '',
    `Anchor: ${latest.gps_lat.toFixed(6)}, ${latest.gps_lon.toFixed(6)}`,
    `Radius: ${radius}m`,
    '',
    'You will be alerted if the bike moves outside this zone while armed.',
  ].join('\n');
}

async function cmdTrips(telegramId, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) return '⚠️ No device linked.';

  const trips = await env.DB.prepare(
    `SELECT * FROM trips WHERE device_id = ? ORDER BY start_time DESC LIMIT 5`
  ).bind(device.device_id).all();

  if (!trips.results?.length) return '📊 No trips recorded yet.';

  const lines = ['📊 <b>Recent Trips</b>', ''];
  for (const t of trips.results) {
    lines.push(
      `🕐 ${(t.start_time || '?').slice(0, 16)} — ${(t.distance_km ?? 0).toFixed(1)} km, ` +
      `Max ${(t.max_speed_kmh ?? 0).toFixed(0)} km/h, ` +
      `Safety: ${t.safety_score ?? '—'}/100`
    );
  }
  return lines.join('\n');
}

async function cmdSubscribe(chatId, telegramId, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) {
    await sendTelegramMessage(chatId, '⚠️ No device linked.', env);
    return ok();
  }

  await sendTelegramMessage(chatId, [
    '💳 <b>Subscription</b>',
    '',
    `Device: <code>${device.device_id}</code>`,
    `Expires: ${device.subscription_expiry || 'N/A'}`,
    'Renewal: $15.00 USD / year',
    '',
    'Tap below to create a KHQR payment invoice:',
  ].join('\n'), env, {
    deviceId: device.device_id,
    replyMarkup: {
      inline_keyboard: [[{ text: '💳 Extend ($15/Year)', callback_data: 'create_invoice' }]],
    },
  });
  return ok();
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const telegramId = String(cb.from.id);

  if (cb.data === 'create_invoice') {
    const invoice = await createInvoice(telegramId, env);
    const text = invoice.error
      ? `⚠️ ${invoice.error}`
      : [
          '💳 <b>Payment Invoice</b>',
          '',
          `Amount: $${invoice.amount_usd.toFixed(2)} USD`,
          `Ref: <code>${invoice.invoice_ref}</code>`,
          '',
          'Scan the KHQR code below with ABA Mobile or Bakong:',
          '',
          `<pre>${invoice.qr_code_data}</pre>`,
          '',
          `⏳ Expires: ${invoice.expires_at}`,
          'Once paid, your subscription auto-extends by 365 days.',
        ].join('\n');

    await sendTelegramMessage(chatId, text, env);
  }
  return ok();
}
