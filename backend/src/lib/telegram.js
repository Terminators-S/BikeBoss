/**
 * Telegram Bot API helpers.
 */

/**
 * Send a Telegram message. Logs to notification_log if DB available.
 */
export async function sendTelegramMessage(chatId, text, env, opts = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('TELEGRAM_BOT_TOKEN not set — skipping send');
    return { ok: false, error: 'no_token' };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      }),
    });
    const data = await resp.json();

    if (env.DB) {
      await env.DB.prepare(
        `INSERT INTO notification_log (user_id, device_id, event_id, chat_id, message_text, sent, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          opts.userId ?? null,
          opts.deviceId ?? null,
          opts.eventId ?? null,
          String(chatId),
          text,
          data.ok ? 1 : 0,
          data.ok ? null : JSON.stringify(data)
        )
        .run()
        .catch(() => {});
    }

    return data;
  } catch (err) {
    console.error('Telegram send failed:', err);
    return { ok: false, error: err.message };
  }
}

export async function answerCallbackQuery(callbackQueryId, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  }).catch(() => {});
}


/**
 * Send a photo (public HTTPS URL or Telegram file_id) with optional HTML caption.
 */
export async function sendTelegramPhoto(chatId, photo, caption, env, opts = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('TELEGRAM_BOT_TOKEN not set — skipping photo');
    return { ok: false, error: 'no_token' };
  }

  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo,
        caption: caption || undefined,
        parse_mode: 'HTML',
        ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      }),
    });
    return await resp.json();
  } catch (err) {
    console.error('Telegram photo send failed:', err);
    return { ok: false, error: err.message };
  }
}
