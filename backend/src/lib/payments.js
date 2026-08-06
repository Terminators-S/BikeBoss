/**
 * ABA PayWay KHQR payment integration.
 *
 * NOTE: Sandbox/placeholder implementation. Replace requestKHQR() with the
 * real PayWay API call and implement signature verification for the webhook
 * before going live.
 */

import { sendTelegramMessage } from './telegram.js';
import { getUserByTelegramId } from './db.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function createInvoice(telegramId, env) {
  const user = await getUserByTelegramId(telegramId, env);
  if (!user) return { error: 'User not registered. Send /start first.' };

  const device = await env.DB.prepare(
    'SELECT device_id FROM devices WHERE owner_id = ? AND is_active = 1 LIMIT 1'
  ).bind(user.id).first();
  if (!device) return { error: 'No active device linked.' };

  const invoiceRef = `BB-INV-${Date.now()}`;
  const amount = 15.0;
  const expiresAt = new Date(Date.now() + 3600000).toISOString();

  const qrData = buildPlaceholderKHQR(env, invoiceRef, amount);

  await env.DB.prepare(
    `INSERT INTO payment_invoices (user_id, device_id, invoice_ref, amount_usd, qr_code_data, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(user.id, device.device_id, invoiceRef, amount, qrData, expiresAt).run();

  return {
    invoice_ref: invoiceRef,
    amount_usd: amount,
    qr_code_data: qrData,
    expires_at: expiresAt,
  };
}

function buildPlaceholderKHQR(env, invoiceRef, amount) {
  // TODO: replace with ABA PayWay API response (real KHQR EMV string)
  const merchantId = env.ABA_PAYWAY_MERCHANT_ID || 'PLACEHOLDER';
  return ['KHQR', merchantId, amount.toFixed(2), 'USD', invoiceRef].join('|');
}

export async function handlePayWayWebhook(body, env) {
  const { txn_id, invoice_ref, status } = body;

  // TODO: verify PayWay HMAC signature before trusting this webhook.

  if (status !== 'PAID') return json({ status: 'ignored' });

  const invoice = await env.DB.prepare(
    'SELECT * FROM payment_invoices WHERE invoice_ref = ?'
  ).bind(invoice_ref).first();

  if (!invoice) return json({ error: 'invoice not found' }, 404);

  await env.DB.prepare(
    `UPDATE payment_invoices
     SET status = 'paid', payway_txn_id = ?, payway_response = ?, paid_at = datetime('now')
     WHERE id = ?`
  ).bind(txn_id ?? null, JSON.stringify(body), invoice.id).run();

  if (invoice.device_id) {
    await env.DB.prepare(
      `UPDATE devices
       SET subscription_expiry = datetime(COALESCE(subscription_expiry, 'now'), '+365 days'),
           updated_at = datetime('now')
       WHERE device_id = ?`
    ).bind(invoice.device_id).run();
  }

  const user = await env.DB.prepare(
    'SELECT telegram_id FROM users WHERE id = ?'
  ).bind(invoice.user_id).first();

  if (user?.telegram_id) {
    await sendTelegramMessage(user.telegram_id, [
      '✅ <b>Payment Confirmed!</b>',
      '',
      `Invoice: <code>${invoice_ref}</code>`,
      `Amount: $${invoice.amount_usd.toFixed(2)} USD`,
      `Transaction: <code>${txn_id || 'N/A'}</code>`,
      '',
      'Your BikeBoss subscription has been extended by <b>365 days</b>.',
      'Thank you for riding with BikeBoss! 🏍️',
    ].join('\n'), env, { deviceId: invoice.device_id });
  }

  return json({ status: 'ok' });
}
