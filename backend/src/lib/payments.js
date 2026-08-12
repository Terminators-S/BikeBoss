/**
 * ABA PayWay / KHQR payment integration.
 *
 * Flow:
 *   1. Dynamic pricing: unique amount ($0.10, $0.11, ...) for bank-notification matching.
 *   2. Prefer REAL PayWay QR via PAYWAY_QR_SERVICE_URL (Playwright scrape of your
 *      merchant link) — always accepted by ABA Mobile.
 *   3. Fallback: local EMV builder (corrected merchant-id format).
 *   4. payment-listener posts { txn_id, amount, secret } to /webhook/abapayway.
 */

import { sendTelegramMessage } from './telegram.js';
import { getUserByTelegramId } from './db.js';
import { buildKHQRPayload, normalizeMerchantAccountId } from './khqr.js';
import { fetchRealPayWayQR } from './payway.js';
import { getBotStrings, getLanguageForDevice } from './i18n.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const BASE_PRICE_USD = 0.10; // test price — change back to 15.0 for production
const INVOICE_TTL_MINUTES = 15;
const SUBSCRIPTION_DAYS = 365;

async function allocateUniqueAmount(env, baseAmount) {
  let offset = 0;
  for (let i = 0; i < 100; i++) {
    const candidate = Math.round((baseAmount + offset) * 100) / 100;
    const clash = await env.DB.prepare(
      `SELECT id FROM payment_invoices
       WHERE status = 'pending' AND ABS(amount_usd - ?) < 0.001`
    ).bind(candidate).first();
    if (!clash) return candidate;
    offset += 0.01;
  }
  return Math.round((baseAmount + (Date.now() % 100) / 100) * 100) / 100;
}

export async function createInvoice(telegramId, env) {
  const user = await getUserByTelegramId(telegramId, env);
  if (!user) return { error: 'User not registered. Send /start first.' };

  const device = await env.DB.prepare(
    'SELECT device_id FROM devices WHERE owner_id = ? AND is_active = 1 LIMIT 1'
  ).bind(user.id).first();
  if (!device) return { error: 'No active device linked.' };

  await env.DB.prepare(
    `UPDATE payment_invoices SET status = 'expired'
     WHERE user_id = ? AND status = 'pending'
     AND expires_at < datetime('now')`
  ).bind(user.id).run();

  const amount = await allocateUniqueAmount(env, BASE_PRICE_USD);
  const invoiceRef = `BB-INV-${Date.now()}`;
  const expiresAt = new Date(Date.now() + INVOICE_TTL_MINUTES * 60000).toISOString();

  const merchantAccountId = normalizeMerchantAccountId(
    env.ABA_MERCHANT_ACCOUNT_ID || '126080611440965'
  );
  const merchantName = env.ABA_MERCHANT_NAME || 'NOV SOKPANHA Bikeboss';

  // 1) Prefer live ABA-issued QR (avoids "invalid QR merchant data")
  let qrPayload = null;
  let qrImageBase64 = null;
  let qrSource = 'emv-fallback';
  const live = await fetchRealPayWayQR(amount, env);
  if (live?.qr_string) {
    qrPayload = live.qr_string;
    qrImageBase64 = live.qr_image_base64;
    qrSource = live.source;
  } else if (live?.qr_image_base64) {
    qrImageBase64 = live.qr_image_base64;
    qrSource = live.source;
  }

  // 2) Fallback: local EMV with corrected merchant fields
  if (!qrPayload) {
    qrPayload = buildKHQRPayload({
      merchantAccountId,
      merchantName,
      merchantCity: 'N/A',
      amount,
      invoiceRef,
    });
  }

  await env.DB.prepare(
    `INSERT INTO payment_invoices (user_id, device_id, invoice_ref, amount_usd, qr_code_data, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(user.id, device.device_id, invoiceRef, amount, qrPayload, expiresAt).run();

  return {
    invoice_ref: invoiceRef,
    amount_usd: amount,
    khqr_payload: qrPayload,
    qr_image_base64: qrImageBase64,
    qr_source: qrSource,
    payway_link: env.PAYWAY_STATIC_LINK || null,
    expires_at: expiresAt,
  };
}

export async function handleInvoiceStatus(invoiceRef, env) {
  const invoice = await env.DB.prepare(
    'SELECT status, paid_at, payway_txn_id FROM payment_invoices WHERE invoice_ref = ?'
  ).bind(invoiceRef).first();

  if (!invoice) return json({ error: 'invoice not found' }, 404);
  return json({
    status: invoice.status,
    paid_at: invoice.paid_at,
    txn_id: invoice.payway_txn_id,
  });
}

export async function handlePayWayWebhook(body, env) {
  const secret = env.PAYMENT_WEBHOOK_SECRET;
  if (secret && body.secret !== secret) {
    return json({ error: 'unauthorized' }, 403);
  }

  const { txn_id, amount } = body;
  const amountNum = Number(amount);
  if (!txn_id || !Number.isFinite(amountNum)) {
    return json({ error: 'txn_id and numeric amount required' }, 400);
  }

  const alreadyUsed = await env.DB.prepare(
    `SELECT id FROM payment_invoices WHERE payway_txn_id = ?`
  ).bind(String(txn_id)).first();
  if (alreadyUsed) return json({ status: 'duplicate' });

  const invoice = await env.DB.prepare(
    `SELECT * FROM payment_invoices
     WHERE status = 'pending'
     AND ABS(amount_usd - ?) < 0.001
     AND expires_at > datetime('now', '-10 minutes')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(amountNum).first();

  if (!invoice) {
    console.warn(`Unmatched ABA txn ${txn_id} for $${amountNum}`);
    return json({ status: 'unmatched' });
  }

  await env.DB.prepare(
    `UPDATE payment_invoices
     SET status = 'paid', payway_txn_id = ?, paid_at = datetime('now')
     WHERE id = ?`
  ).bind(String(txn_id), invoice.id).run();

  if (invoice.device_id) {
    await env.DB.prepare(
      `UPDATE devices
       SET subscription_expiry = datetime(
             MAX(COALESCE(subscription_expiry, 'now'), 'now'), '+${SUBSCRIPTION_DAYS} days'),
           updated_at = datetime('now')
       WHERE device_id = ?`
    ).bind(invoice.device_id).run();
  }

  const user = await env.DB.prepare(
    'SELECT telegram_id FROM users WHERE id = ?'
  ).bind(invoice.user_id).first();

  if (user?.telegram_id) {
    const s = getBotStrings(await getLanguageForDevice(invoice.device_id ?? '', env));
    const lang = s === getBotStrings('km') ? 'km' : 'en';
    const text = lang === 'km'
      ? [
          '✅ <b>ការទូទាត់បានជោគជ័យ!</b>',
          '',
          `វិក្កយបត្រ: <code>${invoice.invoice_ref}</code>`,
          `ចំនួន: $${Number(invoice.amount_usd).toFixed(2)} USD`,
          `ប្រតិបត្តិការ: <code>${txn_id}</code>`,
          '',
          `ការជាវ BikeBoss របស់អ្នកត្រូវបានបន្ត <b>${SUBSCRIPTION_DAYS} ថ្ងៃ</b>។`,
          'អរគុណ! 🏍️',
        ].join('\n')
      : [
          '✅ <b>Payment Confirmed!</b>',
          '',
          `Invoice: <code>${invoice.invoice_ref}</code>`,
          `Amount: $${Number(invoice.amount_usd).toFixed(2)} USD`,
          `Transaction: <code>${txn_id}</code>`,
          '',
          `Your BikeBoss subscription has been extended by <b>${SUBSCRIPTION_DAYS} days</b>.`,
          'Thank you for riding with BikeBoss! 🏍️',
        ].join('\n');

    await sendTelegramMessage(user.telegram_id, text, env, { deviceId: invoice.device_id });
  }

  return json({ status: 'ok', matched: invoice.invoice_ref });
}
