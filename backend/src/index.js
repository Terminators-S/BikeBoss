/**
 * =============================================================================
 * BikeBoss — Cloudflare Worker entrypoint + router
 * =============================================================================
 *
 * API:
 *   POST /api/v1/telemetry        — standard telemetry heartbeat
 *   POST /api/v1/heartbeat        — alias of telemetry
 *   POST /api/v1/crash            — crash event dispatch
 *   POST /api/v1/alert/powercut   — power-cut alert
 *   GET  /api/v1/device/:id       — device dashboard data
 *   GET  /api/v1/trips/:id        — trip history
 *   POST /api/v1/geofence/set     — create geofence zone
 *   POST /api/v1/invoice/create   — create KHQR invoice
 *   POST /webhook/telegram        — Telegram bot webhook
 *   POST /webhook/abapayway       — ABA PayWay payment webhook
 *   GET  /health                  — liveness probe
 */

import { handleTelemetry, handleCrash, handlePowerCutAlert } from './routes/telemetry.js';
import { handleTelegramWebhook } from './routes/telegram.js';
import { handleGetDeviceStatus, handleGetTrips, handleSetGeofence, handleGetLanguage, handleSetLanguage } from './routes/api.js';
import { handlePayWayWebhook, createInvoice, handleInvoiceStatus } from './lib/payments.js';
import { checkHeartbeatTimeout } from './lib/geofence.js';
import { sendTelegramMessage } from './lib/telegram.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function routeRequest(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (method === 'GET' && pathname === '/health') {
    return json({ status: 'ok', service: 'bikeboss-api', time: new Date().toISOString() });
  }

  let body = {};
  if (method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    try {
      if (contentType.includes('application/json')) {
        body = await request.json();
      } else {
        const text = await request.text();
        body = Object.fromEntries(new URLSearchParams(text));
      }
    } catch {
      body = {};
    }
  }

  // --- Device uplink ---
  if (method === 'POST' && (pathname === '/api/v1/telemetry' || pathname === '/api/v1/heartbeat')) {
    return handleTelemetry(body, env);
  }
  if (method === 'POST' && pathname === '/api/v1/crash') return handleCrash(body, env);
  if (method === 'POST' && pathname === '/api/v1/alert/powercut') return handlePowerCutAlert(body, env);

  // --- JSON API ---
  if (method === 'GET' && pathname.startsWith('/api/v1/device/')) {
    return handleGetDeviceStatus(pathname.split('/api/v1/device/')[1], env);
  }
  if (method === 'GET' && pathname.startsWith('/api/v1/trips/')) {
    return handleGetTrips(pathname.split('/api/v1/trips/')[1], env);
  }
  if (method === 'GET' && pathname.startsWith('/api/v1/status/')) {
    return handleGetDeviceStatus(pathname.split('/api/v1/status/')[1], env);
  }
  if (method === 'POST' && pathname === '/api/v1/geofence/set') {
    return handleSetGeofence(body, env);
  }
  if (method === 'GET' && pathname.startsWith('/api/v1/user/') && pathname.endsWith('/language')) {
    const telegramId = pathname.split('/api/v1/user/')[1].replace('/language', '');
    return handleGetLanguage(telegramId, env);
  }
  if (method === 'POST' && pathname === '/api/v1/user/language') {
    return handleSetLanguage(body, env);
  }
  if (method === 'POST' && pathname === '/api/v1/invoice/create') {
    const result = await createInvoice(body.telegram_id, env);
    return json(result, result.error ? 400 : 200);
  }
  if (method === 'GET' && pathname.startsWith('/api/v1/invoice/') && pathname.endsWith('/status')) {
    const ref = pathname.split('/api/v1/invoice/')[1].replace('/status', '');
    return handleInvoiceStatus(ref, env);
  }

  // --- Webhooks ---
  if (method === 'POST' && pathname === '/webhook/telegram') {
    return handleTelegramWebhook(body, env);
  }
  if (method === 'POST' && pathname === '/webhook/abapayway') {
    return handlePayWayWebhook(body, env);
  }

  return json({ error: 'Not found', path: pathname }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await routeRequest(request, env);
    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: 'Internal server error', message: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Every 5 minutes: heartbeat timeout sweep
    const devices = await env.DB.prepare(
      'SELECT device_id FROM devices WHERE is_active = 1'
    ).all();

    for (const d of devices.results || []) {
      await checkHeartbeatTimeout(d.device_id, env).catch(() => {});
    }

    // Daily 9am: subscription expiring within 14 days
    if (event.cron === '0 9 * * *') {
      const expiring = await env.DB.prepare(
        `SELECT d.device_id, d.subscription_expiry, u.telegram_id
         FROM devices d
         JOIN users u ON d.owner_id = u.id
         WHERE d.subscription_expiry BETWEEN datetime('now') AND datetime('now', '+14 days')
         AND d.is_active = 1`
      ).all();

      for (const row of expiring.results || []) {
        await sendTelegramMessage(row.telegram_id, [
          '📅 <b>Subscription Expiring Soon</b>',
          '',
          `Device: <code>${row.device_id}</code>`,
          `Expires: ${row.subscription_expiry}`,
          '',
          'Renew now with /subscribe',
        ].join('\n'), env, { deviceId: row.device_id }).catch(() => {});
      }
    }
  },
};
