/**
 * Payment-system unit tests: KHQR EMV payload + dynamic pricing logic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKHQRPayload } from '../src/lib/khqr.js';

test('KHQR payload: starts with EMV format indicator', () => {
  const p = buildKHQRPayload({
    merchantAccountId: 'bikeboss@abapay',
    merchantName: 'BikeBoss',
    amount: 15.0,
    invoiceRef: 'BB-INV-1',
  });
  assert.ok(p.startsWith('000201'), `got ${p.slice(0, 12)}`);
});

test('KHQR payload: encodes amount and currency USD', () => {
  const p = buildKHQRPayload({
    merchantAccountId: 'bikeboss@abapay',
    merchantName: 'BikeBoss',
    amount: 15.01,
    invoiceRef: 'BB-INV-2',
  });
  assert.ok(p.includes('5303840'), 'currency USD (840) present');
  assert.ok(p.includes('540515.01'), 'amount 15.01 present');
});

test('KHQR payload: includes bill number in additional data', () => {
  const p = buildKHQRPayload({
    merchantAccountId: 'bikeboss@abapay',
    merchantName: 'BikeBoss',
    amount: 15.0,
    invoiceRef: 'BB-INV-12345',
  });
  assert.ok(p.includes('BB-INV-12345'));
});

test('KHQR payload: ends with CRC16 tag (6304 + 4 hex chars)', () => {
  const p = buildKHQRPayload({
    merchantAccountId: 'bikeboss@abapay',
    merchantName: 'BikeBoss',
    amount: 15.0,
    invoiceRef: 'BB-INV-1',
  });
  assert.match(p.slice(-8), /^6304[0-9A-F]{4}$/, `tail: ${p.slice(-8)}`);
});

test('KHQR payload: CRC is deterministic and validates', () => {
  const opts = {
    merchantAccountId: 'bikeboss@abapay',
    merchantName: 'BikeBoss',
    amount: 15.0,
    invoiceRef: 'BB-INV-1',
  };
  const p1 = buildKHQRPayload(opts);
  const p2 = buildKHQRPayload(opts);
  assert.equal(p1, p2, 'same input → same payload');

  // Recompute CRC over everything before the final 8 chars and compare
  const body = p1.slice(0, -4); // includes 6304
  let crc = 0xFFFF;
  for (let i = 0; i < body.length; i++) {
    crc ^= body.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  assert.equal(p1.slice(-4), crc.toString(16).toUpperCase().padStart(4, '0'));
});

test('KHQR payload: different invoice refs produce different CRCs', () => {
  const base = { merchantAccountId: 'bikeboss@abapay', merchantName: 'BikeBoss', amount: 15.0 };
  const a = buildKHQRPayload({ ...base, invoiceRef: 'BB-INV-A' });
  const b = buildKHQRPayload({ ...base, invoiceRef: 'BB-INV-B' });
  assert.notEqual(a, b);
});

test('KHQR payload: merchant name truncated to 25 chars', () => {
  const p = buildKHQRPayload({
    merchantAccountId: 'bikeboss@abapay',
    merchantName: 'A'.repeat(40),
    amount: 15.0,
    invoiceRef: 'BB-INV-1',
  });
  assert.ok(p.includes('5925' + 'A'.repeat(25)), 'name truncated with correct length tag');
});

test('KHQR payload: dynamic pricing amounts encode exactly (collision prevention)', () => {
  for (const cents of [0, 1, 2, 99]) {
    const amount = 15.0 + cents / 100;
    const p = buildKHQRPayload({
      merchantAccountId: 'bikeboss@abapay',
      merchantName: 'BikeBoss',
      amount,
      invoiceRef: 'BB-INV-X',
    });
    const expected = `5405${amount.toFixed(2)}`;
    assert.ok(p.includes(expected), `${expected} in payload`);
  }
});
