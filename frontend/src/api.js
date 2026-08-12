/**
 * API client for the BikeBoss backend.
 *
 * In dev, Vite proxies /api → http://127.0.0.1:8787 (wrangler dev).
 * In production, point to the deployed Worker origin.
 */

const BASE = import.meta.env.VITE_API_BASE || '';
const SESSION_STORAGE_KEY = 'bikeboss_session_v2';

let telegramInitData = null;
let sessionPromise = null;

function readSessionToken() {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveSessionToken(token) {
  try {
    if (token) sessionStorage.setItem(SESSION_STORAGE_KEY, token);
    else sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch { /* storage can be disabled inside privacy-focused browsers */ }
}

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
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || `POST ${path} → ${resp.status}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

async function startSession(initData = telegramInitData, force = false) {
  if (initData) telegramInitData = initData;
  if (!force && readSessionToken()) return readSessionToken();
  if (!telegramInitData) throw new Error('telegram_init_data_missing');
  if (sessionPromise) return sessionPromise;

  sessionPromise = post('/api/v2/auth/telegram', { init_data: telegramInitData })
    .then((result) => {
      saveSessionToken(result.token);
      return result.token;
    })
    .finally(() => { sessionPromise = null; });
  return sessionPromise;
}

async function authenticatedRequest(path, options = {}, retry = true) {
  let token = readSessionToken();
  if (!token) token = await startSession();

  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && retry && telegramInitData) {
    saveSessionToken(null);
    await startSession(telegramInitData, true);
    return authenticatedRequest(path, options, false);
  }
  if (!response.ok) {
    const error = new Error(data.error || `${options.method || 'GET'} ${path} → ${response.status}`);
    error.code = data.error;
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

const authGet = (path) => authenticatedRequest(path);
const authJson = (method, path, body) => authenticatedRequest(path, {
  method,
  body: JSON.stringify(body ?? {}),
});

export const api = {
  startSession,
  setTelegramInitData: (initData) => { telegramInitData = initData || null; },
  meSecure: () => authGet('/api/v2/me'),
  activitySecure: () => authGet('/api/v2/activity'),
  tripDetail: (tripId) => authGet(`/api/v2/trips/${encodeURIComponent(tripId)}`),
  liveDevice: (deviceId) => authGet(`/api/v2/devices/${encodeURIComponent(deviceId)}/live`),
  deviceTrail: (deviceId, range = '1h') => authGet(
    `/api/v2/devices/${encodeURIComponent(deviceId)}/trail?range=${encodeURIComponent(range)}`,
  ),
  listZones: (deviceId) => authGet(`/api/v2/devices/${encodeURIComponent(deviceId)}/zones`),
  createZone: (deviceId, zone) => authJson(
    'POST',
    `/api/v2/devices/${encodeURIComponent(deviceId)}/zones`,
    zone,
  ),
  updateZone: (zoneId, zone) => authJson(
    'PATCH',
    `/api/v2/zones/${encodeURIComponent(zoneId)}`,
    zone,
  ),
  archiveZone: (zoneId, version) => authJson(
    'DELETE',
    `/api/v2/zones/${encodeURIComponent(zoneId)}`,
    { version },
  ),
  setLanguageSecure: (language) => authJson('PATCH', '/api/v2/me/language', { language }),
  linkDeviceSecure: (deviceId) => authJson('POST', '/api/v2/devices/link', { device_id: deviceId }),
  deviceCommandSecure: (deviceId, action) => authJson(
    'POST',
    `/api/v2/devices/${encodeURIComponent(deviceId)}/commands`,
    { action },
  ),
  commandStatus: (deviceId, commandId) => authGet(
    `/api/v2/devices/${encodeURIComponent(deviceId)}/commands/${encodeURIComponent(commandId)}`,
  ),
  firmwareUpdate: (deviceId) => authGet(
    `/api/v2/devices/${encodeURIComponent(deviceId)}/firmware-update`,
  ),
  installFirmwareUpdate: (deviceId, buildNumber, downloadPreference = 'wifi_only') => authJson(
    'POST',
    `/api/v2/devices/${encodeURIComponent(deviceId)}/firmware-update`,
    { build_number: buildNumber, download_preference: downloadPreference },
  ),
  acknowledgeGeofenceEvent: (eventId) => authJson(
    'POST',
    `/api/v2/geofence-events/${encodeURIComponent(eventId)}/acknowledge`,
    {},
  ),
  placeSuggestions: (deviceId) => authGet(
    `/api/v2/devices/${encodeURIComponent(deviceId)}/suggestions`,
  ),
  acceptPlaceSuggestion: (suggestionId, body = {}) => authJson(
    'POST',
    `/api/v2/suggestions/${encodeURIComponent(suggestionId)}/accept`,
    body,
  ),
  dismissPlaceSuggestion: (suggestionId) => authJson(
    'POST',
    `/api/v2/suggestions/${encodeURIComponent(suggestionId)}/dismiss`,
    {},
  ),
  wifiProfiles: (deviceId) => authGet(
    `/api/v2/devices/${encodeURIComponent(deviceId)}/wifi-profiles`,
  ),
  createWifiProfile: (deviceId, profile) => authJson(
    'POST',
    `/api/v2/devices/${encodeURIComponent(deviceId)}/wifi-profiles`,
    profile,
  ),
  updateWifiProfile: (profileId, profile) => authJson(
    'PATCH',
    `/api/v2/wifi-profiles/${encodeURIComponent(profileId)}`,
    profile,
  ),
  archiveWifiProfile: (profileId, version) => authJson(
    'DELETE',
    `/api/v2/wifi-profiles/${encodeURIComponent(profileId)}`,
    { version },
  ),
  createInvoiceSecure: () => authJson('POST', '/api/v2/invoices', {}),
  invoiceStatusSecure: (ref) => authGet(`/api/v2/invoices/${encodeURIComponent(ref)}`),

  // Legacy v1 endpoints retained for demo mode and staged migration only.
  deviceStatus: (deviceId) => get(`/api/v1/device/${deviceId}`),
  trips: (deviceId) => get(`/api/v1/trips/${deviceId}`),
  setGeofence: (payload) => post('/api/v1/geofence/set', payload),
  createInvoice: (telegramId) => post('/api/v1/invoice/create', { telegram_id: telegramId }),
  invoiceStatus: (ref) => get(`/api/v1/invoice/${encodeURIComponent(ref)}/status`),
  getLanguage: (telegramId) => get(`/api/v1/user/${telegramId}/language`),
  setLanguage: (telegramId, language) => post('/api/v1/user/language', { telegram_id: telegramId, language }),

  // New app-context endpoints
  me: (telegramId) => get(`/api/v1/me/${telegramId}`),
  activity: (telegramId) => get(`/api/v1/activity/${telegramId}`),
  registerUser: (telegramId, displayName, handle) =>
    post('/api/v1/user/register', { telegram_id: telegramId, display_name: displayName, handle }),
  linkDevice: (telegramId, deviceId) =>
    post('/api/v1/device/link', { telegram_id: telegramId, device_id: deviceId }),
  deviceCommand: (deviceId, action, telegramId) =>
    post(`/api/v1/device/${encodeURIComponent(deviceId)}/command`, { action, telegram_id: telegramId }),
  geofenceHere: (deviceId, telegramId) =>
    post('/api/v1/geofence/here', { device_id: deviceId, telegram_id: telegramId }),
};

/**
 * Telegram Web App context. Returns null when opened outside Telegram
 * (useful for local dev with a mock).
 */
export function getTelegramContext() {
  const tg = window.Telegram?.WebApp;
  if (!tg?.initDataUnsafe?.user) return null;
  const context = {
    userId: tg.initDataUnsafe.user.id,
    firstName: tg.initDataUnsafe.user.first_name,
    lastName: tg.initDataUnsafe.user.last_name,
    username: tg.initDataUnsafe.user.username,
    photoUrl: tg.initDataUnsafe.user.photo_url,
    initData: tg.initData,
    colorScheme: tg.colorScheme,
  };
  api.setTelegramInitData(context.initData);
  return context;
}

/** Light haptic helper — safe to call anywhere. */
export const haptic = {
  light: () => window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.('light'),
  medium: () => window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.('medium'),
  heavy: () => window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.('heavy'),
  success: () => window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.('success'),
  error: () => window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.('error'),
  select: () => window.Telegram?.WebApp?.HapticFeedback?.selectionChanged?.(),
};

/** Demo-mode device id used when running outside Telegram. */
export const DEMO_DEVICE_ID = 'BB-00000001';
