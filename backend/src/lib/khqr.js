/**
 * KHQR EMV payload generator — pure JavaScript.
 *
 * Matches the structure of real ABA PayWay QRs (decoded Aug 2026):
 *   - Tag 30: GUID abaakhppxxx@abaa + merchant ID digits only (NO @abaa) + "ABA Bank"
 *   - MCC 7832, currency 840, country KH
 *   - Merchant city "N/A" (PayWay default)
 *   - Amount as plain decimal string
 *
 * NOTE: Fully "session-bound" PayWay QRs also carry proprietary tags 62/99
 * issued by ABA at generation time. For scannable payments we prefer the
 * live PayWay QR service (see lib/payway.js). This builder is a fallback.
 */

function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(id, value) {
  const v = String(value);
  return `${id}${v.length.toString().padStart(2, '0')}${v}`;
}

/** ABA PayWay tag-30 merchant id is digits only (e.g. 126080611440965), not *@abaa. */
export function normalizeMerchantAccountId(accountId) {
  const raw = String(accountId || '').trim();
  // strip bakong domain suffix if present
  const noDomain = raw.includes('@') ? raw.split('@')[0] : raw;
  return noDomain.replace(/\s+/g, '');
}

/**
 * @param {object} opts
 * @param {string} opts.merchantAccountId  digits or digits@abaa
 * @param {string} opts.merchantName
 * @param {string} [opts.merchantCity]
 * @param {number} [opts.amount]
 * @param {string} [opts.invoiceRef]
 * @param {string} [opts.currency]  '840' USD default
 */
export function buildKHQRPayload({
  merchantAccountId,
  merchantName,
  merchantCity = 'N/A',
  amount,
  invoiceRef,
  currency = '840',
}) {
  const merchantId = normalizeMerchantAccountId(merchantAccountId);
  if (!merchantId) {
    throw new Error('merchantAccountId required');
  }

  // Tag 30 — ABA PayWay merchant account template (matches live PayWay QR)
  const merchantAccountInfo =
    tlv('00', 'abaakhppxxx@abaa') +
    tlv('01', merchantId) +
    tlv('02', 'ABA Bank');

  // Keep additional data minimal — fake PAYWAY session bills can trigger
  // "invalid QR merchant data" on ABA Mobile.
  const ref = String(invoiceRef || 'BB').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 20);
  const additionalData = tlv('01', ref) + tlv('02', 'ABA');

  let payload =
    tlv('00', '01') +
    tlv('01', amount != null ? '12' : '11') +
    tlv('30', merchantAccountInfo) +
    tlv('52', '7832') +
    tlv('53', currency);

  if (amount != null) {
    // Keep two decimals for unique-cent matching (0.10, 0.11, ...)
    payload += tlv('54', Number(amount).toFixed(2));
  }

  const name = String(merchantName || 'BikeBoss').slice(0, 25);
  const city = String(merchantCity || 'N/A').slice(0, 15);

  payload +=
    tlv('58', 'KH') +
    tlv('59', name) +
    tlv('60', city) +
    tlv('62', additionalData);

  return `${payload}6304${crc16(payload + '6304')}`;
}
