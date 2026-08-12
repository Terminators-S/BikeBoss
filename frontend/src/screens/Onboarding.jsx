import { useState } from 'react';
import { api, haptic } from '../api.js';
import { useLanguage } from '../components/LanguageProvider.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  BikeIcon, ShieldIcon, AlertIcon, PinIcon,
} from '../components/icons.jsx';

const DEVICE_ID_RE = /^BB-[A-Z0-9]{4,}$/;

export default function Onboarding({ telegramId, tgUser, onLinked }) {
  const { t } = useLanguage();
  const toast = useToast();
  const [deviceId, setDeviceId] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const link = async (e) => {
    e.preventDefault();
    const id = deviceId.toUpperCase().trim();

    if (!DEVICE_ID_RE.test(id)) {
      setError(t.linkInvalid);
      haptic.error();
      return;
    }
    if (!telegramId) {
      setError(t.openBotToLink);
      return;
    }

    setBusy(true);
    setError(null);
    haptic.medium();
    try {
      await api.linkDeviceSecure(id);
      toast.success(t.linkSuccess);
      onLinked();
    } catch (err) {
      if (err.code === 'device_taken') setError(t.linkTaken);
      else if (err.code === 'invalid_device_id') setError(t.linkInvalid);
      else if (err.code === 'device_not_provisioned') setError(t.linkNotProvisioned);
      else setError(t.connectionError);
      haptic.error();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <section className="onboard-hero">
        <div className="brand-badge"><BikeIcon /></div>
        <h1>{t.welcomeTitle}</h1>
        <p>{t.welcomeBody}</p>
      </section>

      <section className="card">
        <div className="feature-row">
          <div className="feature-icon"><ShieldIcon /></div>
          <div>
            <div className="f-title">{t.featureAntiTheft}</div>
            <div className="f-body">{t.featureAntiTheftBody}</div>
          </div>
        </div>
        <div className="feature-row">
          <div className="feature-icon"><AlertIcon /></div>
          <div>
            <div className="f-title">{t.featureCrash}</div>
            <div className="f-body">{t.featureCrashBody}</div>
          </div>
        </div>
        <div className="feature-row">
          <div className="feature-icon"><PinIcon /></div>
          <div>
            <div className="f-title">{t.featureTracking}</div>
            <div className="f-body">{t.featureTrackingBody}</div>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>{t.linkTitle}</h2>
        <p className="hint">{t.linkBody}</p>
        <form className="link-form" onSubmit={link}>
          <label className="field-label" htmlFor="device-id">{t.deviceIdLabel}</label>
          <input
            id="device-id"
            className="text-input"
            value={deviceId}
            onChange={(e) => { setDeviceId(e.target.value); setError(null); }}
            placeholder={t.deviceIdPlaceholder}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck="false"
            maxLength={16}
          />
          {error && <p className="field-error">{error}</p>}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy && <span className="spinner" style={{ width: 15, height: 15, borderWidth: 2 }} />}
            {busy ? t.linking : t.linkBtn}
          </button>
        </form>
        {!telegramId && <p className="hint">{t.openBotToLink}</p>}
      </section>
    </div>
  );
}
