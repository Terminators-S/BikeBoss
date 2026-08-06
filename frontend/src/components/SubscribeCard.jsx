import { useState } from 'react';
import { api } from '../api.js';

export default function SubscribeCard({ device, telegramId }) {
  const [invoice, setInvoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const renew = async () => {
    if (!telegramId) {
      setError('Open inside Telegram to renew.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.createInvoice(telegramId);
      if (result.error) throw new Error(result.error);
      setInvoice(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Subscription</h2>
      <div className="sub-row">
        <span className="label">Expires</span>
        <span>{device?.subscription_expiry || 'N/A'}</span>
      </div>
      <div className="sub-row">
        <span className="label">Renewal</span>
        <span>$15.00 / year</span>
      </div>

      {!invoice && (
        <button className="btn primary" onClick={renew} disabled={busy}>
          {busy ? 'Creating invoice…' : '💳 Extend ($15/Year)'}
        </button>
      )}

      {invoice && (
        <div className="invoice">
          <p>Scan with ABA Mobile / Bakong:</p>
          <pre>{invoice.qr_code_data}</pre>
          <p className="label">Ref: {invoice.invoice_ref} · expires {invoice.expires_at}</p>
        </div>
      )}

      {error && <p className="hint error">⚠️ {error}</p>}
    </section>
  );
}
