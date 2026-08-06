/**
 * KHQR EMV payload generator — pure JavaScript, no browser/API needed.
 *
 * Implements the Bakong KHQR standard (EMVCo QR Code Specification for
 * Payment Systems) which is what ABA PayWay renders as a scannable QR.
 * The generated string can be turned into a QR image client-side.
 *
 * Reference: Bakong KHQR SDK field layout.
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
 * Build a KHQR payload string.
 *
 * @param {object} opts
 * @param {string} opts.merchantAccountId  Bakong account ID (e.g. "panha@abapay") —
 *                                         the acquiring account shown in ABA/Bakong apps
 * @param {string} opts.merchantName       Display name (max 25 chars)
 * @param {string} opts.merchantCity       City (e.g. "Phnom Penh")
 * @param {number} opts.amount             USD amount
 * @param {string} opts.invoiceRef         Bill/reference number (shows in payer's app)
 * @param {string} [opts.currency]         '840' = USD (default), '116' = KHR
 */
export function buildKHQRPayload({
  merchantAccountId,
  merchantName,
  merchantCity = 'Phnom Penh',
  amount,
  invoiceRef,
  currency = '840',
}) {
  // Tag 29 = merchant account information template (ABA/Bakong)
  const merchantAccountInfo = tlv('00', 'kh.com.aba') + tlv('01', merchantAccountId);

  const payload =
    tlv('00', '01') +                    // Payload format indicator
    tlv('01', '12') +                    // Point of initiation: 12 = dynamic (amount+bill)
    tlv('29', merchantAccountInfo) +     // Bakong/ABA merchant account
    tlv('52', '5999') +                  // MCC: miscellaneous
    tlv('53', currency) +                // 840 = USD
    tlv('54', amount.toFixed(2)) +       // Amount
    tlv('58', 'KH') +                    // Country
    tlv('59', merchantName.slice(0, 25)) + // Merchant name
    tlv('60', merchantCity) +            // City
    tlv('62', tlv('01', invoiceRef));    // Additional data: bill number

  return `${payload}6304${crc16(payload + '6304')}`;
}
