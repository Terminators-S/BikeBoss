/**
 * API client for the BikeBoss backend.
 *
 * In dev, Vite proxies /api → http://127.0.0.1:8787 (wrangler dev).
 * In production, point to the deployed Worker origin.
 */

const BASE = import.meta.env.VITE_API_BASE || '';

async function get(path) {
  const resp = await fetch(`${BASE}${path}`);
  if (!resp.ok) throw new Error(`GET ${path} → ${resp.status}`);
  return resp.json();
}

async function post(path, body) {
  const resp = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`POST ${path} → ${resp.status}`);
  return resp.json();
}

export const api = {
  deviceStatus: (deviceId) => get(`/api/v1/device/${deviceId}`),
  trips: (deviceId) => get(`/api/v1/trips/${deviceId}`),
  setGeofence: (payload) => post('/api/v1/geofence/set', payload),
  createInvoice: (telegramId) => post('/api/v1/invoice/create', { telegram_id: telegramId }),
};

/**
 * Telegram Web App context. Returns null when opened outside Telegram
 * (useful for local dev with a mock).
 */
export function getTelegramContext() {
  const tg = window.Telegram?.WebApp;
  if (!tg?.initDataUnsafe?.user) return null;
  return {
    userId: tg.initDataUnsafe.user.id,
    firstName: tg.initDataUnsafe.user.first_name,
    initData: tg.initData,
    colorScheme: tg.colorScheme,
  };
}

/** Demo-mode device id used when running outside Telegram. */
export const DEMO_DEVICE_ID = 'BB-00000001';
