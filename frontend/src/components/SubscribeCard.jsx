import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { api } from '../api.js';
import { useLanguage } from './LanguageProvider.jsx';

const POLL_INTERVAL_MS = 4000;

export default function SubscribeCard({ device, telegramId }) {
  const { t, lang } = useLanguage();
  const [invoice, setInvoice] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [paid, setPaid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  // Render KHQR payload → QR image whenever invoice changes
  useEffect(() => {
    if (!invoice?.khqr_payload) return;
    QRCode.toDataURL(invoice.khqr_payload, { width: 280, margin: 2 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [invoice]);

  // Poll invoice status until paid / expired
  useEffect(() => {
    if (!invoice?.invoice_ref || paid) return;

    pollRef.current = setInterval(async () => {
      try {
        const { status } = await api.invoiceStatus(invoice.invoice_ref);
        if (status === 'paid') {
          setPaid(true);
          clearInterval(pollRef.current);
          if (window.Telegram?.WebApp?.HapticFeedback) {
            window.Telegram.WebApp.HapticFeedback.notificationOccurred('success');
          }
        } else if (status === 'expired') {
          setError(t.invoiceExpired ?? 'Invoice expired. Create a new one.');
          setInvoice(null);
          clearInterval(pollRef.current);
        }
      } catch { /* keep polling */ }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(pollRef.current);
  }, [invoice, paid, t]);

  const renew = async () => {
    if (!telegramId) {
      setError(t.openInTelegramToRenew);
      return;
    }
    setBusy(true);
    setError(null);
    setPaid(false);
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

      {!invoice && !paid && (
        <button className="btn primary" onClick={renew} disabled={busy}>
          {busy ? t.creatingInvoice : t.extendBtn}
        </button>
      )}

      {invoice && !paid && (
        <div className="invoice">
          <p className="amount-big">${invoice.amount_usd.toFixed(2)}</p>
          <p>{t.scanWith}</p>
          {qrDataUrl
            ? <img className="qr-img" src={qrDataUrl} alt="KHQR payment code" />
            : (
              <a className="btn" href={invoice.payway_link} target="_blank" rel="noreferrer">
                {t.payViaLink ?? 'Pay via ABA PayWay link'}
              </a>
            )}
          <p className="label">Ref: {invoice.invoice_ref}</p>
          <p className="label">{t.expires}: {new Date(invoice.expires_at).toLocaleTimeString()}</p>
          <p className="hint">{t.waitingPayment ?? 'Waiting for payment… this updates automatically.'}</p>
        </div>
      )}

      {paid && (
        <div className="paid-banner">
          ✅ {t.paymentConfirmed ?? 'Payment confirmed! Subscription extended 365 days.'}
        </div>
      )}

      {error && <p className="hint error">⚠️ {error}</p>}
    </section>
  );
}
