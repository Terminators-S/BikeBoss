import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, haptic } from '../api.js';
import { useLanguage } from './LanguageProvider.jsx';
import { useToast } from './Toast.jsx';
import Sheet from './Sheet.jsx';
import {
  AlertIcon,
  CheckCircleIcon,
  CloudIcon,
  LockIcon,
  RefreshIcon,
  SatelliteIcon,
  ShieldIcon,
  WifiIcon,
} from './icons.jsx';

const POLL_MS = 3_000;
const ACTIVE_STATES = new Set(['queued', 'preparing']);

function formatSize(bytes, t) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return t.notAvailable;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function stateText(status, t) {
  return ({
    available: [t.updateAvailable, t.updateAvailableBody],
    queued: [t.updateQueued, t.updateQueuedBody],
    preparing: [t.updatePreparing, t.updatePreparingBody],
    up_to_date: [t.updateCurrent, t.updateCurrentBody],
    failed: [t.updateFailed, t.updateFailedBody],
    usb_required: [t.updateUsbRequired, t.updateUsbRequiredBody],
    service_required: [t.updateServiceRequired, t.updateServiceRequiredBody],
    read_only: [t.updateReadOnly, t.updateReadOnlyBody],
    unavailable: [t.updateUnavailable, t.updateUnavailableBody],
  })[status] ?? [t.updateUnavailable, t.updateUnavailableBody];
}

function ProgressStep({ done, active, label }) {
  return (
    <div className={`update-step ${done ? 'done' : ''} ${active ? 'active' : ''}`}>
      <span>{done ? <CheckCircleIcon /> : null}</span>
      <small>{label}</small>
    </div>
  );
}

function ReadinessItem({ ready, waiting, icon, title, detail }) {
  return (
    <div className={`update-readiness-item ${ready ? 'ready' : waiting ? 'waiting' : ''}`}>
      <span className="update-readiness-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      <span className="update-readiness-state">
        {ready ? <CheckCircleIcon /> : waiting ? <RefreshIcon /> : <AlertIcon />}
      </span>
    </div>
  );
}

export default function FirmwareUpdateSheet({ open, onClose, device, onUpdated }) {
  const { t } = useLanguage();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [downloadPreference, setDownloadPreference] = useState('wifi_only');

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!device?.device_id) return;
    if (!quiet) setLoading(true);
    try {
      const result = await api.firmwareUpdate(device.device_id);
      setData(result);
      setDownloadPreference(result.update?.download_preference ?? 'wifi_only');
      setLoadError(false);
      if (result.update?.status === 'up_to_date') onUpdated?.();
    } catch {
      setLoadError(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [device?.device_id, onUpdated]);

  useEffect(() => {
    if (!open) return undefined;
    load();
    return undefined;
  }, [open, load]);

  const status = data?.update?.status ?? 'unavailable';
  useEffect(() => {
    if (!open || !ACTIVE_STATES.has(status)) return undefined;
    const timer = setInterval(() => load({ quiet: true }), POLL_MS);
    return () => clearInterval(timer);
  }, [open, status, load]);

  const install = async () => {
    const buildNumber = data?.update?.release?.build_number;
    if (!buildNumber || installing) return;
    setInstalling(true);
    haptic.medium();
    try {
      const result = await api.installFirmwareUpdate(
        device.device_id,
        buildNumber,
        downloadPreference,
      );
      setData(result);
      haptic.success();
      toast.success(t.updateRequestSent);
      onUpdated?.();
    } catch (error) {
      haptic.error();
      if (error.code === 'firmware_update_changed') await load();
      toast.error(t.updateRequestFailed);
    } finally {
      setInstalling(false);
    }
  };

  const release = data?.update?.release;
  const readiness = data?.readiness ?? {};
  const [title, body] = stateText(status, t);
  const stage = useMemo(() => ({
    available: 1,
    queued: 2,
    preparing: 3,
    up_to_date: 4,
    failed: 2,
  })[status] ?? 0, [status]);
  const heroIcon = status === 'up_to_date'
    ? <CheckCircleIcon />
    : status === 'failed' ? <AlertIcon /> : <RefreshIcon />;
  const wifiReady = readiness.trusted_wifi_connected === true;
  const wifiWaiting = readiness.trusted_wifi_configured === true && !wifiReady;
  const safelyParked = readiness.disarmed === true && readiness.stationary === true;
  const anyInternet = downloadPreference === 'any_internet';
  const connectionReady = anyInternet
    ? readiness.any_internet_connected === true
    : wifiReady;

  return (
    <Sheet open={open} onClose={onClose} closeLabel={t.done}>
      <div className="sheet-title"><RefreshIcon />{t.firmwareUpdateTitle}</div>

      {loading && !data ? (
        <div className="update-loading">
          <span className="spinner" />
          <p>{t.checkingForUpdates}</p>
        </div>
      ) : loadError && !data ? (
        <div className="update-error-state">
          <AlertIcon />
          <strong>{t.updateCheckFailed}</strong>
          <button className="btn secondary" type="button" onClick={() => load()}>
            <RefreshIcon />{t.retry}
          </button>
        </div>
      ) : (
        <>
          <section className={`update-hero ${status}`}>
            <div className="update-hero-icon">{heroIcon}</div>
            <span className="update-eyebrow">{t.signedBikeBossUpdate}</span>
            <h2>{title}</h2>
            <p>{body}</p>
            <div className="update-version-chip">
              <span>{t.currentVersion} <strong>{data?.current?.version ?? '—'}</strong></span>
              <span className="update-version-arrow">→</span>
              <span>{t.latestVersion} <strong>{release?.version ?? data?.current?.version ?? '—'}</strong></span>
            </div>
          </section>

          {release && (
            <div className="update-progress" aria-label={t.updateProgress}>
              {[t.updateStepSecure, t.updateStepQueued, t.updateStepInstall, t.updateStepReady]
                .map((label, index) => (
                  <ProgressStep
                    key={label}
                    label={label}
                    done={stage > index}
                    active={stage === index + 1 && status !== 'up_to_date'}
                  />
                ))}
            </div>
          )}

          <section className="update-section">
            <div className="update-section-head">
              <div>
                <span>{t.whatsNew}</span>
                <h3>{t.gpsReliabilityUpdate}</h3>
              </div>
              {release && <small>{formatSize(release.size_bytes, t)} · {t.buildLabel(release.build_number)}</small>}
            </div>
            <div className="update-highlights">
              <div><SatelliteIcon /><span><strong>{t.updateGpsCleanTitle}</strong><small>{t.updateGpsCleanBody}</small></span></div>
              <div><CloudIcon /><span><strong>{t.updateOfflineReplayTitle}</strong><small>{t.updateOfflineReplayBody}</small></span></div>
              <div><ShieldIcon /><span><strong>{t.updateJumpGuardTitle}</strong><small>{t.updateJumpGuardBody}</small></span></div>
              <div><SatelliteIcon /><span><strong>{t.updateDriftEngineTitle}</strong><small>{t.updateDriftEngineBody}</small></span></div>
            </div>
          </section>

          {data?.update?.can_install && (
            <section className="update-section update-transport-section">
              <div className="update-section-head compact">
                <div>
                  <span>{t.downloadPreference}</span>
                  <h3>{t.chooseDownloadConnection}</h3>
                </div>
              </div>
              <div className="update-transport-options" role="radiogroup" aria-label={t.chooseDownloadConnection}>
                <button
                  className={`update-transport-option ${downloadPreference === 'wifi_only' ? 'selected' : ''}`}
                  type="button"
                  role="radio"
                  aria-checked={downloadPreference === 'wifi_only'}
                  onClick={() => { setDownloadPreference('wifi_only'); haptic.select(); }}
                >
                  <span className="update-transport-icon"><WifiIcon /></span>
                  <span className="update-transport-copy">
                    <strong>{t.downloadWifiOnly}<em>{t.downloadWifiOnlyRecommended}</em></strong>
                    <small>{t.downloadWifiOnlyBody}</small>
                  </span>
                  <span className="update-radio" />
                </button>
                <button
                  className={`update-transport-option ${downloadPreference === 'any_internet' ? 'selected' : ''}`}
                  type="button"
                  role="radio"
                  aria-checked={downloadPreference === 'any_internet'}
                  onClick={() => { setDownloadPreference('any_internet'); haptic.select(); }}
                >
                  <span className="update-transport-icon cellular"><CloudIcon /></span>
                  <span className="update-transport-copy">
                    <strong>{t.downloadAnyInternet}</strong>
                    <small>{t.downloadAnyInternetBody}</small>
                  </span>
                  <span className="update-radio" />
                </button>
              </div>
            </section>
          )}

          <section className="update-section">
            <div className="update-section-head compact">
              <div>
                <span>{t.installReadiness}</span>
                <h3>{t.safeAutomaticInstall}</h3>
              </div>
            </div>
            <div className="update-readiness-list">
              <ReadinessItem
                ready={readiness.signed_bootstrap === true}
                icon={<LockIcon />}
                title={t.signedFirmwareReady}
                detail={readiness.signed_bootstrap ? t.signedFirmwareReadyBody : t.signedFirmwareMissingBody}
              />
              <ReadinessItem
                ready={readiness.tracker_online === true}
                waiting={readiness.tracker_online !== true}
                icon={<CloudIcon />}
                title={t.trackerConnectionReady}
                detail={readiness.tracker_online ? t.trackerConnectionReadyBody : t.trackerConnectionWaitingBody}
              />
              <ReadinessItem
                ready={connectionReady}
                waiting={!connectionReady && (anyInternet || wifiWaiting)}
                icon={anyInternet ? <CloudIcon /> : <WifiIcon />}
                title={anyInternet ? t.mobileInternetReady : t.trustedWifiReady}
                detail={anyInternet
                  ? (connectionReady ? t.mobileInternetReadyBody : t.mobileInternetWaitingBody)
                  : (wifiReady
                    ? t.trustedWifiReadyBody
                    : wifiWaiting ? t.trustedWifiWaitingBody : t.trustedWifiMissingBody)}
              />
              <ReadinessItem
                ready={safelyParked}
                waiting={!safelyParked}
                icon={<ShieldIcon />}
                title={t.parkedReady}
                detail={safelyParked ? t.parkedReadyBody : t.parkedWaitingBody}
              />
            </div>
          </section>

          <div className="update-security-note">
            <LockIcon />
            <span><strong>{t.updateSecurityTitle}</strong>{t.updateSecurityBody}</span>
          </div>

          {data?.update?.can_install && (
            <button className="btn primary update-install-btn" type="button" onClick={install} disabled={installing}>
              {installing ? <span className="spinner" /> : <RefreshIcon />}
              {installing ? t.sendingUpdate : status === 'failed' ? t.retryUpdate : t.installUpdate}
            </button>
          )}
        </>
      )}
    </Sheet>
  );
}
