import { useState } from 'react';
import { api } from '../api.js';
import { useLanguage } from './LanguageProvider.jsx';

export default function SubscribeCard({ device, telegramId }) {
  const { t } = useLanguage();
  const [invoice, setInvoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const renew = async () => {
    if (!telegramId) {
      setError(t.openInTelegramToRenew);
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
      <h2>{t.subscription}</h2>
      <div className="sub-row">
        <span className="label">{t.expires}</span>
        <span>{device?.subscription_expiry || 'N/A'}</span>
      </div>
      <div className="sub-row">
        <span className="label">{t.renewal}</span>
        <span>$15.00 {t.perYear}</span>
      </div>

      {!invoice && (
        <button className="btn primary" onClick={renew} disabled={busy}>
          {busy ? t.creatingInvoice : t.extendBtn}
        </button>
      )}

      {invoice && (
        <div className="invoice">
          <p>{t.scanWith}</p>
          <pre>{invoice.qr_code_data}</pre>
          <p className="label">Ref: {invoice.invoice_ref} · {t.expires} {invoice.expires_at}</p>
        </div>
      )}

      {error && <p className="hint error">⚠️ {error}</p>}
    </section>
  );
}
