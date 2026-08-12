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

import {
  handleTelemetry, handleTelemetryV2, handleTelemetryBatchV2,
  handleCrash, handlePowerCutAlert,
} from './routes/telemetry.js';
import { handleTelegramWebhook } from './routes/telegram.js';
import {
  handleGetDeviceStatus, handleGetTrips, handleSetGeofence,
  handleGetLanguage, handleSetLanguage, handleRegisterUser,
  handleGetMe, handleDeviceCommand, handleLinkDevice,
  handleGeofenceHere, handleGetActivity,
} from './routes/api.js';
import { handlePayWayWebhook, createInvoice, handleInvoiceStatus } from './lib/payments.js';
import { checkHeartbeatTimeout } from './lib/geofence.js';
import { sendTelegramMessage } from './lib/telegram.js';
import { authenticateUserRequest } from './lib/auth.js';
import { handleFirmwareDownloadV2 } from './lib/firmware-ota.js';
import {
  handleTelegramSession, handleGetMeV2, handleGetLiveDeviceV2,
  handleGetDeviceTrailV2, handleGetTripV2,
  handleListZonesV2, handleCreateZoneV2, handleUpdateZoneV2,
  handleArchiveZoneV2, handleGetActivityV2, handleSetLanguageV2,
  handleLinkDeviceV2, handleDeviceCommandV2, handleGetDeviceCommandV2,
  handleListWifiProfilesV2, handleCreateWifiProfileV2,
  handleUpdateWifiProfileV2, handleArchiveWifiProfileV2,
  handleGetFirmwareUpdateV2, handleInstallFirmwareUpdateV2,
  handleAcknowledgeGeofenceEventV2,
  handleListPlaceSuggestionsV2, handleAcceptPlaceSuggestionV2,
  handleDismissPlaceSuggestionV2,
  handleCreateInvoiceV2, handleGetInvoiceStatusV2,
} from './routes/v2.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': [
    'Content-Type', 'Authorization', 'If-Match',
    'X-BikeBoss-Auth',
    'X-BikeBoss-Timestamp', 'X-BikeBoss-Sequence',
    'X-BikeBoss-Key-Version', 'X-BikeBoss-Signature',
  ].join(', '),
};

const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_TELEMETRY_BODY_BYTES = 512;
const MAX_TELEMETRY_BATCH_BODY_BYTES = 4 * 1024;
const LEGACY_DEVICE_MIGRATION_PATHS = new Set([
  '/api/v1/telemetry',
  '/api/v1/heartbeat',
  '/api/v1/crash',
  '/api/v1/alert/powercut',
]);

export function deviceMigrationRelayUrl(requestUrl, configuredOrigin) {
  if (!configuredOrigin) return null;
  const source = new URL(requestUrl);
  if (!source.pathname.startsWith('/api/v2/device/')
      && !LEGACY_DEVICE_MIGRATION_PATHS.has(source.pathname)) {
    return null;
  }
  const origin = new URL(configuredOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('DEVICE_MIGRATION_ORIGIN must be an HTTPS origin without a path');
  }
  if (source.origin === origin.origin) return null;
  origin.pathname = source.pathname;
  origin.search = source.search;
  return origin;
}

function requestBodyLimit(pathname) {
  if (pathname === '/api/v2/device/telemetry') return MAX_TELEMETRY_BODY_BYTES;
  if (pathname === '/api/v2/device/telemetry/batch') {
    return MAX_TELEMETRY_BATCH_BODY_BYTES;
  }
  return MAX_JSON_BODY_BYTES;
}

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  // Temporary bootstrap bridge: a tracker on the previous build still calls
  // the staging Worker. Forward only device-originated routes to the home-lab
  // API so the rider-approved endpoint migration OTA can reach it. Requests
  // retain their signed path/body and are re-verified by the home server.
  const relayUrl = deviceMigrationRelayUrl(request.url, env.DEVICE_MIGRATION_ORIGIN);
  if (relayUrl) {
    const relayedRequest = new Request(relayUrl, request);
    relayedRequest.headers.set('X-BikeBoss-Migration-Relay', 'staging-worker');
    return fetch(relayedRequest);
  }

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (method === 'GET' && pathname === '/health') {
    return json({ status: 'ok', service: 'bikeboss-api', time: new Date().toISOString() });
  }

  if (method === 'GET' && pathname === '/webhook/telegram') {
    return json({
      status: 'ok',
      service: 'bikeboss-telegram-webhook',
      accepts: 'POST',
      time: new Date().toISOString(),
    });
  }

  let body = {};
  let rawBody = '';
  if (['POST', 'PATCH', 'DELETE'].includes(method)) {
    const maximumBodyBytes = requestBodyLimit(pathname);
    const contentLength = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maximumBodyBytes) {
      return json({ error: 'request_too_large' }, 413);
    }
    const contentType = request.headers.get('content-type') || '';
    try {
      rawBody = await request.text();
      if (new TextEncoder().encode(rawBody).byteLength > maximumBodyBytes) {
        return json({ error: 'request_too_large' }, 413);
      }
      if (contentType.includes('application/json')) {
        body = rawBody ? JSON.parse(rawBody) : {};
      } else {
        body = Object.fromEntries(new URLSearchParams(rawBody));
      }
    } catch {
      return json({ error: 'invalid_request_body' }, 400);
    }
  }

  // --- Version 2 Mini App authentication ---
  if (method === 'POST' && pathname === '/api/v2/auth/telegram') {
    return handleTelegramSession(body, env);
  }

  if (method === 'POST' && pathname === '/api/v2/device/telemetry') {
    return handleTelemetryV2(request, rawBody, body, env, ctx);
  }

  if (method === 'POST' && pathname === '/api/v2/device/telemetry/batch') {
    return handleTelemetryBatchV2(request, rawBody, body, env, ctx);
  }

  const firmwareDownloadMatch = /^\/api\/v2\/device\/([^/]+)\/firmware\/([^/]+)$/u.exec(pathname);
  if (method === 'GET' && firmwareDownloadMatch) {
    return handleFirmwareDownloadV2(
      request,
      decodeURIComponent(firmwareDownloadMatch[1]),
      decodeURIComponent(firmwareDownloadMatch[2]),
      env,
    );
  }

  if (pathname.startsWith('/api/v2/')) {
    const actor = await authenticateUserRequest(request, env);
    if (!actor) return json({ error: 'unauthorized' }, 401);
    const requestId = request.headers.get('CF-Ray') ?? crypto.randomUUID();

    if (method === 'GET' && pathname === '/api/v2/me') {
      return handleGetMeV2(actor, env);
    }
    if (method === 'GET' && pathname === '/api/v2/activity') {
      return handleGetActivityV2(actor, env);
    }
    const tripMatch = /^\/api\/v2\/trips\/([^/]+)$/u.exec(pathname);
    if (method === 'GET' && tripMatch) {
      return handleGetTripV2(actor, decodeURIComponent(tripMatch[1]), env);
    }
    if (method === 'PATCH' && pathname === '/api/v2/me/language') {
      return handleSetLanguageV2(actor, body, env, requestId);
    }
    if (method === 'POST' && pathname === '/api/v2/devices/link') {
      return handleLinkDeviceV2(actor, body, env, requestId);
    }
    if (method === 'POST' && pathname === '/api/v2/invoices') {
      return handleCreateInvoiceV2(actor, env, requestId);
    }
    const invoiceMatch = /^\/api\/v2\/invoices\/([^/]+)$/u.exec(pathname);
    if (method === 'GET' && invoiceMatch) {
      return handleGetInvoiceStatusV2(actor, decodeURIComponent(invoiceMatch[1]), env);
    }

    const liveMatch = /^\/api\/v2\/devices\/([^/]+)\/live$/u.exec(pathname);
    if (method === 'GET' && liveMatch) {
      return handleGetLiveDeviceV2(actor, decodeURIComponent(liveMatch[1]), env);
    }

    const trailMatch = /^\/api\/v2\/devices\/([^/]+)\/trail$/u.exec(pathname);
    if (method === 'GET' && trailMatch) {
      return handleGetDeviceTrailV2(
        actor,
        decodeURIComponent(trailMatch[1]),
        url,
        env,
      );
    }

    const zonesMatch = /^\/api\/v2\/devices\/([^/]+)\/zones$/u.exec(pathname);
    if (zonesMatch) {
      const deviceId = decodeURIComponent(zonesMatch[1]);
      if (method === 'GET') return handleListZonesV2(actor, deviceId, env);
      if (method === 'POST') {
        return handleCreateZoneV2(actor, deviceId, body, env, requestId);
      }
    }

    const suggestionsMatch = /^\/api\/v2\/devices\/([^/]+)\/suggestions$/u.exec(pathname);
    if (method === 'GET' && suggestionsMatch) {
      return handleListPlaceSuggestionsV2(
        actor,
        decodeURIComponent(suggestionsMatch[1]),
        env,
      );
    }

    const wifiProfilesMatch = /^\/api\/v2\/devices\/([^/]+)\/wifi-profiles$/u.exec(pathname);
    if (wifiProfilesMatch) {
      const deviceId = decodeURIComponent(wifiProfilesMatch[1]);
      if (method === 'GET') return handleListWifiProfilesV2(actor, deviceId, env);
      if (method === 'POST') {
        return handleCreateWifiProfileV2(actor, deviceId, body, env, requestId);
      }
    }

    const wifiProfileMatch = /^\/api\/v2\/wifi-profiles\/([^/]+)$/u.exec(pathname);
    if (wifiProfileMatch) {
      const profileId = decodeURIComponent(wifiProfileMatch[1]);
      if (method === 'PATCH') {
        return handleUpdateWifiProfileV2(actor, profileId, body, env, requestId);
      }
      if (method === 'DELETE') {
        return handleArchiveWifiProfileV2(actor, profileId, body, env, requestId);
      }
    }

    const commandMatch = /^\/api\/v2\/devices\/([^/]+)\/commands$/u.exec(pathname);
    if (method === 'POST' && commandMatch) {
      return handleDeviceCommandV2(
        actor,
        decodeURIComponent(commandMatch[1]),
        body,
        env,
        requestId,
      );
    }
    const firmwareUpdateMatch = /^\/api\/v2\/devices\/([^/]+)\/firmware-update$/u.exec(pathname);
    if (firmwareUpdateMatch) {
      const deviceId = decodeURIComponent(firmwareUpdateMatch[1]);
      if (method === 'GET') {
        return handleGetFirmwareUpdateV2(actor, deviceId, env);
      }
      if (method === 'POST') {
        return handleInstallFirmwareUpdateV2(
          actor,
          deviceId,
          body,
          env,
          requestId,
        );
      }
    }
    const commandStatusMatch = /^\/api\/v2\/devices\/([^/]+)\/commands\/(\d+)$/u.exec(pathname);
    if (method === 'GET' && commandStatusMatch) {
      return handleGetDeviceCommandV2(
        actor,
        decodeURIComponent(commandStatusMatch[1]),
        Number(commandStatusMatch[2]),
        env,
      );
    }
    const eventAckMatch = /^\/api\/v2\/geofence-events\/([^/]+)\/acknowledge$/u.exec(pathname);
    if (method === 'POST' && eventAckMatch) {
      return handleAcknowledgeGeofenceEventV2(
        actor,
        decodeURIComponent(eventAckMatch[1]),
        env,
        requestId,
      );
    }
    const suggestionActionMatch = /^\/api\/v2\/suggestions\/([^/]+)\/(accept|dismiss)$/u.exec(pathname);
    if (method === 'POST' && suggestionActionMatch) {
      const suggestionId = decodeURIComponent(suggestionActionMatch[1]);
      return suggestionActionMatch[2] === 'accept'
        ? handleAcceptPlaceSuggestionV2(actor, suggestionId, body, env, requestId)
        : handleDismissPlaceSuggestionV2(actor, suggestionId, env, requestId);
    }

    const zoneMatch = /^\/api\/v2\/zones\/([^/]+)$/u.exec(pathname);
    if (zoneMatch) {
      const zoneUuid = decodeURIComponent(zoneMatch[1]);
      if (method === 'PATCH') {
        return handleUpdateZoneV2(actor, zoneUuid, body, env, requestId);
      }
      if (method === 'DELETE') {
        return handleArchiveZoneV2(actor, zoneUuid, body, env, requestId);
      }
    }

    return json({ error: 'not_found', path: pathname }, 404);
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
  if (method === 'POST' && pathname === '/api/v1/geofence/here') {
    return handleGeofenceHere(body, env);
  }
  if (method === 'GET' && pathname.startsWith('/api/v1/me/')) {
    return handleGetMe(pathname.split('/api/v1/me/')[1], env);
  }
  if (method === 'GET' && pathname.startsWith('/api/v1/activity/')) {
    return handleGetActivity(pathname.split('/api/v1/activity/')[1], env);
  }
  if (method === 'POST' && pathname.startsWith('/api/v1/device/') && pathname.endsWith('/command')) {
    const deviceId = pathname.split('/api/v1/device/')[1].replace('/command', '');
    return handleDeviceCommand(deviceId, body, env);
  }
  if (method === 'POST' && pathname === '/api/v1/device/link') {
    return handleLinkDevice(body, env);
  }
  if (method === 'POST' && pathname === '/api/v1/user/register') {
    return handleRegisterUser(body, env);
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

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  headers.delete('Access-Control-Allow-Origin');
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  const origin = request.headers.get('Origin');
  const allowedOrigins = String(env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.append('Vary', 'Origin');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return withCors(await routeRequest(request, env, ctx), request, env);
    } catch (err) {
      console.error(JSON.stringify({
        message: 'worker_request_failed',
        error: err instanceof Error ? err.message : String(err),
      }));
      return withCors(json({ error: 'internal_server_error' }, 500), request, env);
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
