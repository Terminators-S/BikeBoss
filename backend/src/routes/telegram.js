/**
 * Telegram Bot webhook handler — commands + inline callbacks.
 */

import { sendTelegramMessage, answerCallbackQuery } from '../lib/telegram.js';
import {
  upsertUser, getUserByTelegramId, getDeviceForUser, getDevice, latestTelemetry,
  logEvent, queueDeviceCommand,
} from '../lib/db.js';
import { createInvoice } from '../lib/payments.js';

const ok = () => new Response('OK', { status: 200 });

const ARM_LABELS = {
  en: ['🟢 Disarmed', '🔴 Armed', '🟡 Pending Unlock'],
  km: ['🟢 បើកប្រព័ន្ធ', '🔴 បិទប្រព័ន្ធ (ការពារ)', '🟡 រង់ចាំការបើក'],
};

const STR = {
  en: {
    help: [
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
      '/lang — Change language / ផ្លាស់ប្តូរភាសា',
      '/help — Show this help',
    ].join('\n'),
    welcome: (u) => [
      `🏍️ <b>Welcome to BikeBoss, ${u.name}!</b>`,
      '',
      'Your motorcycle security & safety companion — anti-theft, crash detection, and keyless access, all from Telegram.',
      '',
      '👤 <b>Your BikeBoss account</b>',
      `• Name: <b>${u.name}</b>`,
      `• Username: <b>${u.username}</b>`,
      `• Telegram ID: <code>${u.telegramId}</code>`,
      '',
      '🔑 Your Telegram ID is your <b>unique account identity</b> — your device links to it, and all alerts & payments are tied to it.',
      '',
      '👉 Next: link your device with /register <code>BB-xxxxxxxx</code>',
      '👉 Open the app: tap <b>🏍️ BikeBoss</b> in the menu button',
      '',
      'Type /help anytime to see all commands.',
    ].join('\n'),
    welcomeBack: (name) => `🏍️ Welcome back, <b>${name}</b>! Type /help for commands, or tap the 🏍️ menu button to open the app.`,
    noDevice: '⚠️ No device linked. Use /register <code>BB-xxxxxxxx</code>.',
    registerUsage: '⚠️ Usage: /register <code>BB-xxxxxxxx</code>\nThe device ID is printed on your BikeBoss unit label.',
    registerNew: (id) => `✅ <b>Device registered & linked!</b>\n\nDevice: <code>${id}</code>\nThis unit was auto-provisioned. Try /status once it comes online.`,
    alreadyMine: (id) => `ℹ️ <code>${id}</code> is already linked to your account.`,
    alreadyTaken: (id) => `⚠️ <code>${id}</code> is linked to another account. Contact support to transfer.`,
    linked: (id) => `✅ <b>Device linked!</b>\n\nDevice: <code>${id}</code>\nTry /status to see live data.`,
    unknown: 'Unknown command. Type /help for available commands.',
    noGps: '⚠️ No GPS fix available right now. Try again in a moment.',
    noGpsGeofence: '⚠️ No GPS fix available. Cannot set geofence.',
    noTrips: '📊 No trips recorded yet.',
    commandQueued: (action, id) => `✅ <b>${action}</b> command queued for <code>${id}</code>. It applies on the next device heartbeat.`,
    geofenceSet: (lat, lon, radius) => [
      '📍 <b>Geofence Set</b>',
      '',
      `Anchor: ${lat}, ${lon}`,
      `Radius: ${radius}m`,
      '',
      'You will be alerted if the bike moves outside this zone while armed.',
    ].join('\n'),
    subPrompt: 'Tap below to create a KHQR payment invoice:',
    langSet: '✅ Language set to English. All text will be in English.',
  },
  km: {
    help: [
      '🏍️ <b>ពាក្យបញ្ជា BikeBoss</b>',
      '',
      '/register <code>BB-xxxxxxxx</code> — ភ្ជាប់ឧបករណ៍របស់អ្នក',
      '/status — មើលស្ថានភាពម៉ូតូ',
      '/arm — បិទប្រព័ន្ធ (ការពារ)',
      '/disarm — បើកប្រព័ន្ធ',
      '/locate — មើលទីតាំង GPS',
      '/geofence — កំណត់តំបន់ការពារ',
      '/trips — ដំណើរថ្មីៗ',
      '/subscribe — គ្រប់គ្រងការជាវ',
      '/lang — ផ្លាស់ប្តូរភាសា / Change language',
      '/help — មើលជំនួយ',
    ].join('\n'),
    welcome: (u) => [
      `🏍️ <b>សូមស្វាគមន៍មកកាន់ BikeBoss, ${u.name}!</b>`,
      '',
      'ដៃគូការពារ និងសុវត្ថិភាពម៉ូតូរបស់អ្នក — ប្រឆាំងការលួច រកឃើញគ្រោះថ្នាក់ និងបើកដោយគ្មានសោ ទាំងអស់ក្នុង Telegram។',
      '',
      '👤 <b>គណនី BikeBoss របស់អ្នក</b>',
      `• ឈ្មោះ: <b>${u.name}</b>`,
      `• ឈ្មោះអ្នកប្រើ: <b>${u.username}</b>`,
      `• លេខសម្គាល់ Telegram: <code>${u.telegramId}</code>`,
      '',
      '🔑 លេខសម្គាល់ Telegram របស់អ្នកគឺជា <b>អត្តសញ្ញាណគណនីផ្តាច់មុខ</b> — ឧបករណ៍របស់អ្នកភ្ជាប់ទៅវា ហើយការជូនដំណឹង និងការទូទាត់ទាំងអស់ចាត់ទុកតាមវា។',
      '',
      '👉 បន្ទាប់: ភ្ជាប់ឧបករណ៍របស់អ្នកដោយ /register <code>BB-xxxxxxxx</code>',
      '👉 បើកកម្មវិធី: ចុច <b>🏍️ BikeBoss</b> នៅប៊ូតុងម៉ឺនុយ',
      '',
      'វាយ /help គ្រប់ពេលដើម្បីមើលពាក្យបញ្ជាទាំងអស់។',
    ].join('\n'),
    welcomeBack: (name) => `🏍️ សូមស្វាគមន៍, <b>${name}</b>! វាយ /help សម្រាប់ពាក្យបញ្ជា ឬចុចប៊ូតុង 🏍️ ដើម្បីបើកកម្មវិធី។`,
    noDevice: '⚠️ មិនទាន់ភ្ជាប់ឧបករណ៍។ ប្រើ /register <code>BB-xxxxxxxx</code>។',
    registerUsage: '⚠️ ប្រើ: /register <code>BB-xxxxxxxx</code>\nលេខកូដឧបករណ៍ស្ថិតនៅលើស្លាក BikeBoss របស់អ្នក។',
    registerNew: (id) => `✅ <b>ឧបករណ៍ត្រូវបានចុះឈ្មោះ & ភ្ជាប់!</b>\n\nឧបករណ៍: <code>${id}</code>\nសាក /status នៅពេលឧបករណ៍ដំណើរការ។`,
    alreadyMine: (id) => `ℹ️ <code>${id}</code> បានភ្ជាប់ជាមួយគណនីរបស់អ្នករួចហើយ។`,
    alreadyTaken: (id) => `⚠️ <code>${id}</code> ភ្ជាប់ជាមួយគណនីផ្សេង។ ទាក់ទងជំនួយដើម្បីផ្ទេរ។`,
    linked: (id) => `✅ <b>ឧបករណ៍បានភ្ជាប់!</b>\n\nឧបករណ៍: <code>${id}</code>\nសាក /status ដើម្បីមើលទិន្នន័យ។`,
    unknown: 'ពាក្យបញ្ជាមិនស្គាល់។ វាយ /help សម្រាប់ពាក្យបញ្ជា។',
    noGps: '⚠️ គ្មានសញ្ញា GPS ឥឡូវនេះទេ។ សាកម្តងទៀត។',
    noGpsGeofence: '⚠️ គ្មានសញ្ញា GPS។ មិនអាចកំណត់តំបន់បានទេ។',
    noTrips: '📊 មិនទាន់មានដំណើរទេ។',
    commandQueued: (action, id) => `✅ ពាក្យបញ្ជា <b>${action}</b> បានដាក់ជូន <code>${id}</code>។ នឹងមានប្រសិទ្ធភាពនៅ heartbeat បន្ទាប់។`,
    geofenceSet: (lat, lon, radius) => [
      '📍 <b>តំបន់ការពារបានកំណត់</b>',
      '',
      `ចំណុច: ${lat}, ${lon}`,
      `កាំ: ${radius}m`,
      '',
      'អ្នកនឹងទទួលការជូនដំណឹងបើម៉ូតូចេញក្រៅតំបន់នេះពេលបិទប្រព័ន្ធ។',
    ].join('\n'),
    subPrompt: 'ចុចខាងក្រោមដើម្បីបង្កើតវិក្កយបត្រ KHQR:',
    langSet: '✅ ភាសាត្រូវបានកំណត់ជាភាសាខ្មែរ។ អត្ថបទទាំងអស់នឹងជាភាសាខ្មែរ។',
  },
};

const LANG_PROMPT = 'ជ្រើសរើសភាសា / Choose your language:';
const LANG_KEYBOARD = {
  inline_keyboard: [[
    { text: '🇬🇧 English', callback_data: 'lang_en' },
    { text: '🇰🇭 ខ្មែរ', callback_data: 'lang_km' },
  ]],
};

const s = (lang) => STR[lang === 'km' ? 'km' : 'en'];

async function getLangSafe(telegramId, env) {
  const user = await getUserByTelegramId(telegramId, env);
  return user?.language === 'km' ? 'km' : 'en';
}

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

  // Register user (language stays NULL until they pick on /start)
  await upsertUser({
    telegramId,
    handle: msg.from.username ?? null,
    displayName: msg.from.first_name ?? 'Rider',
  }, env);

  const user = await getUserByTelegramId(telegramId, env);
  const lang = user?.language === 'km' ? 'km' : 'en';
  const t = s(lang);

  // --- /start ---
  if (text.startsWith('/start')) {
    if (!user?.language) {
      // First-ever interaction: force language choice before anything else
      await sendTelegramMessage(chatId, [
        '🏍️ <b>Welcome to BikeBoss!</b>',
        '<b>សូមស្វាគមន៍មកកាន់ BikeBoss!</b>',
        '',
        LANG_PROMPT,
      ].join('\n'), env, { replyMarkup: LANG_KEYBOARD });
      return ok();
    }
    // Returning user → localized welcome-back
    await sendTelegramMessage(chatId, t.welcomeBack(user.display_name ?? 'Rider'), env);
    return ok();
  }

  // --- Gate: if language never chosen, ask again and stop ---
  if (!user?.language && !text.startsWith('/lang')) {
    await sendTelegramMessage(chatId, LANG_PROMPT, env, { replyMarkup: LANG_KEYBOARD });
    return ok();
  }

  let reply = null;

  if (text.startsWith('/register')) {
    reply = await cmdRegister(text, telegramId, t, env);
  } else if (text.startsWith('/status')) {
    reply = await cmdStatus(telegramId, lang, t, env);
  } else if (text.startsWith('/locate')) {
    reply = await cmdLocate(telegramId, t, env);
  } else if (text.startsWith('/arm')) {
    reply = await cmdArmDisarm(telegramId, 'ARM', t, env);
  } else if (text.startsWith('/disarm')) {
    reply = await cmdArmDisarm(telegramId, 'DISARM', t, env);
  } else if (text.startsWith('/geofence')) {
    reply = await cmdGeofence(telegramId, t, env);
  } else if (text.startsWith('/trips')) {
    reply = await cmdTrips(telegramId, t, env);
  } else if (text.startsWith('/subscribe')) {
    return cmdSubscribe(chatId, telegramId, t, env);
  } else if (text.startsWith('/lang')) {
    return cmdLanguage(chatId, telegramId, text, env);
  } else if (text.startsWith('/help')) {
    reply = t.help;
  } else {
    reply = t.unknown;
  }

  if (reply) {
    await sendTelegramMessage(chatId, reply, env);
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdRegister(text, telegramId, t, env) {
  const parts = text.split(/\s+/);
  const deviceId = parts[1]?.toUpperCase();

  if (!deviceId || !/^BB-[A-Z0-9]{4,}$/.test(deviceId)) {
    return t.registerUsage;
  }

  const device = await getDevice(deviceId, env);

  if (!device) {
    const user = await upsertUser({ telegramId }, env);
    await env.DB.prepare(
      `INSERT INTO devices (device_id, owner_id) VALUES (?, ?)`
    ).bind(deviceId, user.id).run();
    return t.registerNew(deviceId);
  }

  if (device.owner_id) {
    const owner = await env.DB.prepare(
      'SELECT telegram_id FROM users WHERE id = ?'
    ).bind(device.owner_id).first();
    if (owner?.telegram_id === telegramId) {
      return t.alreadyMine(deviceId);
    }
    return t.alreadyTaken(deviceId);
  }

  const user = await upsertUser({ telegramId }, env);
  await env.DB.prepare(
    `UPDATE devices SET owner_id = ?, updated_at = datetime('now') WHERE device_id = ?`
  ).bind(user.id, deviceId).run();

  return t.linked(deviceId);
}

async function cmdStatus(telegramId, lang, t, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) return t.noDevice;

  const latest = await latestTelemetry(device.device_id, env);
  const lastEvent = await env.DB.prepare(
    `SELECT event_type, created_at FROM events WHERE device_id = ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(device.device_id).first();

  const armLabels = ARM_LABELS[lang];

  return [
    `🏍️ <b>${device.vehicle_model || 'BikeBoss'}</b>`,
    `📟 <code>${device.device_id}</code>`,
    '',
    `🔐 ${armLabels[latest?.arm_state ?? 0]}`,
    `📡 GPS: ${latest?.gps_fix ? '✅' : '❌'}`,
    `📍 ${latest?.received_at || '—'}`,
    `🔋 ${latest?.vbat != null ? latest.vbat.toFixed(1) + 'V' : 'N/A'}`,
    `🏁 ${latest?.gps_speed != null ? latest.gps_speed.toFixed(1) + ' km/h' : '0 km/h'}`,
    '',
    `📅 ${device.subscription_expiry || 'N/A'}`,
    lastEvent ? `\n⚠️ <b>${lastEvent.event_type}</b> (${lastEvent.created_at})` : '',
  ].join('\n');
}

async function cmdLocate(telegramId, t, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) return t.noDevice;

  const latest = await latestTelemetry(device.device_id, env);
  if (!latest?.gps_fix || latest.gps_lat == null) {
    return t.noGps;
  }

  return [
    '📍 <b>Live Location</b>',
    '',
    `🌐 <code>${latest.gps_lat.toFixed(6)}, ${latest.gps_lon.toFixed(6)}</code>`,
    `🏁 ${(latest.gps_speed ?? 0).toFixed(1)} km/h`,
    `🕐 ${latest.received_at}`,
    '',
    `🗺️ <a href="https://maps.google.com/?q=${latest.gps_lat},${latest.gps_lon}">Google Maps</a>`,
  ].join('\n');
}

async function cmdArmDisarm(telegramId, action, t, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) return t.noDevice;

  await queueDeviceCommand(device.device_id, action, env, { by: telegramId });
  await logEvent(device.device_id, action, 'info', env, {
    payload: { commanded_by: telegramId },
  });

  return t.commandQueued(action, device.device_id);
}

async function cmdGeofence(telegramId, t, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) return t.noDevice;

  const latest = await env.DB.prepare(
    `SELECT gps_lat, gps_lon FROM telemetry
     WHERE device_id = ? AND gps_fix = 1
     ORDER BY received_at DESC LIMIT 1`
  ).bind(device.device_id).first();

  if (!latest) return t.noGpsGeofence;

  const radius = Number(env.GEOFENCE_DEFAULT_RADIUS_M ?? 100);

  await env.DB.prepare(
    `UPDATE geofence_zones SET is_active = 0 WHERE device_id = ? AND label = 'Current Location'`
  ).bind(device.device_id).run();

  await env.DB.prepare(
    `INSERT INTO geofence_zones (device_id, label, anchor_lat, anchor_lon, radius_m, is_active)
     VALUES (?, 'Current Location', ?, ?, ?, 1)`
  ).bind(device.device_id, latest.gps_lat, latest.gps_lon, radius).run();

  return t.geofenceSet(latest.gps_lat.toFixed(6), latest.gps_lon.toFixed(6), radius);
}

async function cmdTrips(telegramId, t, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) return t.noDevice;

  const trips = await env.DB.prepare(
    `SELECT * FROM trips WHERE device_id = ? ORDER BY start_time DESC LIMIT 5`
  ).bind(device.device_id).all();

  if (!trips.results?.length) return t.noTrips;

  const lines = ['📊', ''];
  for (const trip of trips.results) {
    lines.push(
      `🕐 ${(trip.start_time || '?').slice(0, 16)} — ${(trip.distance_km ?? 0).toFixed(1)} km, ` +
      `${(trip.max_speed_kmh ?? 0).toFixed(0)} km/h, ` +
      `${trip.safety_score ?? '—'}/100`
    );
  }
  return lines.join('\n');
}

async function cmdSubscribe(chatId, telegramId, t, env) {
  const device = await getDeviceForUser(telegramId, env);
  if (!device) {
    await sendTelegramMessage(chatId, t.noDevice, env);
    return ok();
  }

  await sendTelegramMessage(chatId, [
    '💳 <b>Subscription</b>',
    '',
    `Device: <code>${device.device_id}</code>`,
    `Expires: ${device.subscription_expiry || 'N/A'}`,
    'Renewal: $15.00 USD / year',
    '',
    t.subPrompt,
  ].join('\n'), env, {
    deviceId: device.device_id,
    replyMarkup: {
      inline_keyboard: [[{ text: '💳 Extend ($15/Year)', callback_data: 'create_invoice' }]],
    },
  });
  return ok();
}

async function cmdLanguage(chatId, telegramId, text, env) {
  const parts = text.split(/\s+/);
  const choice = parts[1]?.toLowerCase();

  if (choice === 'en' || choice === 'km') {
    await env.DB.prepare(
      `UPDATE users SET language = ?, updated_at = datetime('now') WHERE telegram_id = ?`
    ).bind(choice, telegramId).run();

    await sendTelegramMessage(chatId, s(choice).langSet, env);
    return ok();
  }

  await sendTelegramMessage(chatId, LANG_PROMPT, env, { replyMarkup: LANG_KEYBOARD });
  return ok();
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const telegramId = String(cb.from.id);

  if (cb.data === 'lang_en' || cb.data === 'lang_km') {
    const choice = cb.data === 'lang_km' ? 'km' : 'en';
    await env.DB.prepare(
      `UPDATE users SET language = ?, updated_at = datetime('now') WHERE telegram_id = ?`
    ).bind(choice, telegramId).run();

    const t = s(choice);
    await sendTelegramMessage(chatId, t.langSet, env);

    // Full welcome showing the user's identity — the core of their account
    const user = await getUserByTelegramId(telegramId, env);
    const name = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(' ') || user?.display_name || 'Rider';
    const username = cb.from.username ? `@${cb.from.username}` : '—';
    await sendTelegramMessage(chatId, t.welcome({
      name,
      username,
      telegramId,
    }), env);
    return ok();
  }

  if (cb.data === 'create_invoice') {
    const invoice = await createInvoice(telegramId, env);
    const lang = await getLangSafe(telegramId, env);
    const text = invoice.error
      ? `⚠️ ${invoice.error}`
      : lang === 'km'
        ? [
            '💳 <b>វិក្កយបត្រទូទាត់</b>',
            '',
            `ចំនួន: <b>$${invoice.amount_usd.toFixed(2)}</b> USD`,
            `លេខយោង: <code>${invoice.invoice_ref}</code>`,
            '',
            '👉 បើកកម្មវិធី BikeBoss (ប៊ូតុង 🏍️ ក្នុងម៉ឺនុយ) ដើម្បីមើល QR ហើយស្កេនជាមួយ ABA Mobile / Bakong។',
            '',
            `⏳ ផុតកំណត់ក្នុង 15 នាទី។ ការទូទាត់ត្រូវបានបញ្ជាក់ដោយស្វ័យប្រវត្តិ។`,
          ].join('\n')
        : [
            '💳 <b>Payment Invoice</b>',
            '',
            `Amount: <b>$${invoice.amount_usd.toFixed(2)}</b> USD`,
            `Ref: <code>${invoice.invoice_ref}</code>`,
            '',
            '👉 Open the BikeBoss app (🏍️ menu button) to see the QR and scan with ABA Mobile / Bakong.',
            '',
            '⏳ Expires in 15 minutes. Payment confirms automatically.',
          ].join('\n');

    await sendTelegramMessage(chatId, text, env);
    return ok();
  }

  return ok();
}