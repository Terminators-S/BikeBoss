/**
 * ABA PayWay / KHQR payment integration.
 *
 * Flow (adapted from the CreativeStudioWeb guide for Cloudflare Workers):
 *   1. Dynamic pricing: allocate a unique amount ($15.00, $15.01, ...) so the
 *      bank notification (amount-only) maps to exactly one pending invoice.
 *   2. Generate a real Bakong KHQR EMV payload locally (no browser needed) —
 *      the Mini App renders it as a QR image.
 *   3. An external payment-listener service (Pyrogram) watches the ABA bank
 *      notification chat and calls POST /webhook/abapayway with
 *      { txn_id, amount, secret } — we match by exact amount + time window.
 */

import { sendTelegramMessage } from './telegram.js';
import { getUserByTelegramId } from './db.js';
import { buildKHQRPayload } from './khqr.js';
import { getBotStrings, getLanguageForDevice } from './i18n.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const BASE_PRICE_USD = 15.0;
const INVOICE_TTL_MINUTES = 15;   // matches bank-notification matching window
const SUBSCRIPTION_DAYS = 365;

/**
 * Allocate a collision-free amount: base price + $0.01 increments until no
 * other pending invoice holds that amount.
 */
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
  // Fallback: add cents from timestamp (extremely unlikely path)
  return Math.round((baseAmount + (Date.now() % 100) / 100) * 100) / 100;
}

export async function createInvoice(telegramId, env) {
  const user = await getUserByTelegramId(telegramId, env);
  if (!user) return { error: 'User not registered. Send /start first.' };

  const device = await env.DB.prepare(
    'SELECT device_id FROM devices WHERE owner_id = ? AND is_active = 1 LIMIT 1'
  ).bind(user.id).first();
  if (!device) return { error: 'No active device linked.' };

  // Expire any of this user's stale pending invoices first
  await env.DB.prepare(
    `UPDATE payment_invoices SET status = 'expired'
     WHERE user_id = ? AND status = 'pending'
     AND expires_at < datetime('now')`
  ).bind(user.id).run();

  const amount = await allocateUniqueAmount(env, BASE_PRICE_USD);
  const invoiceRef = `BB-INV-${Date.now()}`;
  const expiresAt = new Date(Date.now() + INVOICE_TTL_MINUTES * 60000).toISOString();

  // Build the real KHQR EMV payload — scannable by ABA Mobile / Bakong.
  // EMV is primary; Mini App falls back to the PayWay link if rendering fails.
  const qrPayload = buildKHQRPayload({
    merchantAccountId: env.ABA_MERCHANT_ACCOUNT_ID || 'bikeboss@abapay',
    merchantName: env.ABA_MERCHANT_NAME || 'BikeBoss',
    merchantCity: 'Phnom Penh',
    amount,
    invoiceRef,
  });

  await env.DB.prepare(
    `INSERT INTO payment_invoices (user_id, device_id, invoice_ref, amount_usd, qr_code_data, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(user.id, device.device_id, invoiceRef, amount, qrPayload, expiresAt).run();

  return {
    invoice_ref: invoiceRef,
    amount_usd: amount,
    khqr_payload: qrPayload,
    payway_link: env.PAYWAY_STATIC_LINK || null,  // fallback path
    expires_at: expiresAt,
  };
}

/**
 * GET /api/v1/invoice/:ref/status — Mini App polls this while QR is shown.
 */
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

/**
 * Payment confirmation webhook — called by the external payment-listener
 * service when an ABA bank notification arrives in the Telegram chat.
 *
 * Body: { txn_id, amount, secret }
 * Matching: exact amount (±0.001) among pending, non-expired invoices.
 */
export async function handlePayWayWebhook(body, env) {
  // Shared-secret auth between the listener and this worker
  const secret = env.PAYMENT_WEBHOOK_SECRET;
  if (secret && body.secret !== secret) {
    return json({ error: 'unauthorized' }, 403);
  }

  const { txn_id, amount } = body;
  const amountNum = Number(amount);
  if (!txn_id || !Number.isFinite(amountNum)) {
    return json({ error: 'txn_id and numeric amount required' }, 400);
  }

  // Replay protection: same bank transaction never matches twice
  const alreadyUsed = await env.DB.prepare(
    `SELECT id FROM payment_invoices WHERE payway_txn_id = ?`
  ).bind(String(txn_id)).first();
  if (alreadyUsed) return json({ status: 'duplicate' });

  // Match pending invoice by unique amount, still inside its validity window
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
          `ចំនួន: $${invoice.amount_usd.toFixed(2)} USD`,
          `ប្រតិបត្តិការ: <code>${txn_id}</code>`,
          '',
          `ការជាវ BikeBoss របស់អ្នកត្រូវបានបន្ត <b>${SUBSCRIPTION_DAYS} ថ្ងៃ</b>។`,
          'អរគុណ! 🏍️',
        ].join('\n')
      : [
          '✅ <b>Payment Confirmed!</b>',
          '',
          `Invoice: <code>${invoice.invoice_ref}</code>`,
          `Amount: $${invoice.amount_usd.toFixed(2)} USD`,
          `Transaction: <code>${txn_id}</code>`,
          '',
          `Your BikeBoss subscription has been extended by <b>${SUBSCRIPTION_DAYS} days</b>.`,
          'Thank you for riding with BikeBoss! 🏍️',
        ].join('\n');

    await sendTelegramMessage(user.telegram_id, text, env, { deviceId: invoice.device_id });
  }

  return json({ status: 'ok', matched: invoice.invoice_ref });
}
