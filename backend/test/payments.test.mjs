/**
 * Payment-system unit tests: KHQR EMV payload (PayWay-compatible format).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKHQRPayload } from '../src/lib/khqr.js';

const BASE = {
  merchantAccountId: '126080611440965@abaa',
  merchantName: 'NOV SOKPANHA Bikeboss',
  merchantCity: 'PHNOM PENH',
  invoiceRef: 'TEST-1',
};

function tlvParse(s) {
  const out = {};
  let i = 0;
  while (i < s.length - 4) {
    const tag = s.slice(i, i + 2);
    const len = parseInt(s.slice(i + 2, i + 4), 10);
    out[tag] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

test('KHQR: starts with EMV format indicator + dynamic POI', () => {
  const p = buildKHQRPayload({ ...BASE, amount: 15.0 });
  assert.ok(p.startsWith('00020101'), `got ${p.slice(0, 8)}`);
  assert.ok(p.slice(8).startsWith('0212'), 'dynamic point-of-initiation (12) when amount present');
});

test('KHQR: static POI (11) when no amount', () => {
  const p = buildKHQRPayload({ ...BASE });
  assert.ok(p.slice(8).startsWith('0211'), 'static point-of-initiation (11) when amount omitted');
});

test('KHQR: tag 30 uses ABA PayWay GUID + account + acquirer', () => {
  const p = buildKHQRPayload({ ...BASE, amount: 15.0 });
  const t = tlvParse(p);
  assert.ok(t['30'].includes('abaakhppxxx@abaa'), 'ABA GUID present');
  assert.ok(t['30'].includes('126080611440965@abaa'), 'merchant account present');
  assert.ok(t['30'].includes('ABA Bank'), 'acquirer present');
});

test('KHQR: MCC 7832 (payment service provider)', () => {
  const t = tlvParse(buildKHQRPayload({ ...BASE, amount: 15.0 }));
  assert.equal(t['52'], '7832');
});

test('KHQR: amount and USD currency encoded', () => {
  const t = tlvParse(buildKHQRPayload({ ...BASE, amount: 15.01 }));
  assert.equal(t['53'], '840');
  assert.equal(t['54'], '15.01');
});

test('KHQR: bill number carries PAYWAY@ABA prefix + invoice ref, store label ABA', () => {
  const t = tlvParse(buildKHQRPayload({ ...BASE, amount: 15.0, invoiceRef: 'BB-INV-42' }));
  const add = tlvParse(t['62'].padEnd(t['62'].length + 4, '0')); // nested TLV needs re-parse
  assert.ok(t['62'].includes('PAYWAY@ABA'), 'PAYWAY bill prefix present');
  assert.ok(t['62'].includes('BB-INV-42'), 'invoice ref in bill number');
  assert.ok(t['62'].includes('02' + '03ABA'), 'store label ABA present');
});

test('KHQR: merchant name truncated to 25 chars with correct length', () => {
  const p = buildKHQRPayload({ ...BASE, merchantName: 'A'.repeat(40), amount: 15.0 });
  assert.ok(p.includes('5925' + 'A'.repeat(25)));
});

test('KHQR: ends with CRC tag 6304 + 4 hex and CRC validates', () => {
  const p = buildKHQRPayload({ ...BASE, amount: 15.0 });
  assert.match(p.slice(-8), /^6304[0-9A-F]{4}$/);

  const body = p.slice(0, -4);
  let crc = 0xFFFF;
  for (let i = 0; i < body.length; i++) {
    crc ^= body.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  assert.equal(p.slice(-4), crc.toString(16).toUpperCase().padStart(4, '0'));
});

test('KHQR: dynamic pricing amounts encode exactly (collision prevention)', () => {
  for (const cents of [0, 1, 2, 99]) {
    const amount = 15.0 + cents / 100;
    const t = tlvParse(buildKHQRPayload({ ...BASE, amount }));
    assert.equal(t['54'], amount.toFixed(2));
  }
});

test('KHQR: matches the real decoded PayWay structure field-by-field', () => {
  // Reference: real QR from https://link.payway.com.kh/ABAPAY30494500t (static, no amount)
  const REF = {
    '00': '01', '01': '11',
    '52': '7832', '53': '840', '58': 'KH',
    '59': 'NOV SOKPANHA Bikeboss', '60': 'PHNOM PENH',
  };
  const t = tlvParse(buildKHQRPayload({
    merchantAccountId: '126080611440965@abaa',
    merchantName: 'NOV SOKPANHA Bikeboss',
    merchantCity: 'PHNOM PENH',
    invoiceRef: '09032408732',
  }));
  for (const [tag, val] of Object.entries(REF)) {
    assert.equal(t[tag], val, `tag ${tag}`);
  }
  assert.ok(t['30'].includes('abaakhppxxx@abaa'));
  assert.ok(t['30'].includes('126080611440965@abaa'));
});
