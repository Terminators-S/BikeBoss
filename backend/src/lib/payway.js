/**
 * Fetch a real ABA PayWay KHQR payload (qr_string) for a unique amount.
 *
 * Preferred path: call the local/public payment-listener scrape service which
 * drives the merchant PayWay link with Playwright and returns ABA's own
 * qr_string (always accepted by ABA Mobile).
 *
 * Env:
 *   PAYWAY_QR_SERVICE_URL  e.g. http://127.0.0.1:8791  or a tunnel URL
 *   PAYWAY_STATIC_LINK     merchant link (used by the scraper)
 */

export async function fetchRealPayWayQR(amount, env) {
  const base = (env.PAYWAY_QR_SERVICE_URL || '').replace(/\/$/, '');
  if (!base) return null;

  const url = `${base}/qr?amount=${encodeURIComponent(Number(amount).toFixed(2))}`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      console.warn('PayWay QR service HTTP', resp.status);
      return null;
    }
    const data = await resp.json();
    // Prefer EMV string; fall back to base64 image handled by caller
    if (data.qr_string && String(data.qr_string).startsWith('000201')) {
      return {
        qr_string: data.qr_string,
        qr_image_base64: data.qr_base64 || data.qr_image_base64 || null,
        source: 'payway-service',
      };
    }
    if (data.qr_base64 || data.qr_image_base64) {
      return {
        qr_string: null,
        qr_image_base64: data.qr_base64 || data.qr_image_base64,
        source: 'payway-service-image',
      };
    }
  } catch (err) {
    console.warn('PayWay QR service failed:', err.message || err);
  }
  return null;
}
