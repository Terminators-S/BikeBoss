/**
 * KHQR EMV payload generator — pure JavaScript, no browser/API needed.
 *
 * Implements the Bakong KHQR standard (EMVCo QR Code Specification for
 * Payment Systems) matching the exact structure that ABA PayWay renders.
 * Verified byte-for-byte compatible with real PayWay-generated QRs
 * (tag 30 with "abaakhppxxx@abaa" GUID + ABA Bank acquirer, MCC 7832,
 * PAYWAY@ABA bill number, "ABA" store label).
 *
 * Reference: real PayWay QR decoded from merchant link (Aug 2026).
 */

// CRC16-CCITT (0xFFFF, poly 0x1021) — required by EMV spec
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

/** EMV TLV: id (2 digits) + length (2 digits) + value */
function tlv(id, value) {
  const v = String(value);
  return `${id}${v.length.toString().padStart(2, '0')}${v}`;
}

/**
 * Build a KHQR payload string (ABA PayWay-compatible format).
 *
 * @param {object} opts
 * @param {string} opts.merchantAccountId  Bakong account ID (digits + "@abaa",
 *                                         e.g. "126080611440965@abaa")
 * @param {string} opts.merchantName       Display name (max 25 chars)
 * @param {string} opts.merchantCity       City (e.g. "PHNOM PENH")
 * @param {number} opts.amount             USD amount (omit/undefined for open amount)
 * @param {string} opts.invoiceRef         Reference (mapped to ABA bill number slot)
 * @param {string} [opts.currency]         '840' = USD (default), '116' = KHR
 */
export function buildKHQRPayload({
  merchantAccountId,
  merchantName,
  merchantCity = 'PHNOM PENH',
  amount,
  invoiceRef,
  currency = '840',
}) {
  // Tag 30 — ABA PayWay merchant account template (verified against live QR)
  const merchantAccountInfo =
    tlv('00', 'abaakhppxxx@abaa') +   // ABA global unique identifier
    tlv('01', merchantAccountId) +    // merchant's Bakong account
    tlv('02', 'ABA Bank');            // acquirer

  // Tag 62 — additional data: bill number carries the PAYWAY ref + invoice ref
  const billNumber = `PAYWAY@ABA0106537566${String(invoiceRef).slice(0, 12)}`;
  const additionalData =
    tlv('01', billNumber) +           // bill number (what ABA shows as reference)
    tlv('02', 'ABA');                 // store label

  let payload =
    tlv('00', '01') +                 // payload format indicator
    tlv('01', amount != null ? '12' : '11') +  // 12 = dynamic (fixed amount), 11 = static
    tlv('30', merchantAccountInfo) +
    tlv('52', '7832') +               // MCC 7832 — payment service provider
    tlv('53', currency);

  if (amount != null) {
    payload += tlv('54', Number(amount).toFixed(2));
  }

  payload +=
    tlv('58', 'KH') +
    tlv('59', merchantName.slice(0, 25)) +
    tlv('60', merchantCity) +
    tlv('62', additionalData);

  return `${payload}6304${crc16(payload + '6304')}`;
}
