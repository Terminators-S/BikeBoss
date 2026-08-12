import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, haptic } from '../api.js';
import { useLanguage } from '../components/LanguageProvider.jsx';
import { useToast } from '../components/Toast.jsx';
import Sheet from '../components/Sheet.jsx';
import FirmwareUpdateSheet from '../components/FirmwareUpdateSheet.jsx';
import UserAvatar from '../components/UserAvatar.jsx';
import { timeAgo, fmtDateLong } from '../format.js';
import {
  CardIcon, CheckCircleIcon, LockIcon, BikeIcon, RefreshIcon,
  WifiIcon, PhoneIcon, CloudIcon, SatelliteIcon, ChevronRightIcon, ToolsIcon,
  InfoIcon, EditIcon, TrashIcon, SignalIcon,
} from '../components/icons.jsx';

const POLL_INTERVAL_MS = 4000;
const EMPTY_WIFI_FORM = {
  id: null, version: null, label: '', ssid: '', password: '', priority: 50,
};

function subscriptionActive(expiry) {
  if (!expiry) return false;
  return new Date(`${expiry}Z`).getTime() > Date.now();
}

function readPhoneConnection() {
  const connection = navigator.connection
    || navigator.mozConnection
    || navigator.webkitConnection
    || null;
  return {
    online: navigator.onLine !== false,
    type: connection?.type ?? null,
    effectiveType: connection?.effectiveType ?? null,
    downlink: Number.isFinite(connection?.downlink) ? connection.downlink : null,
    rtt: Number.isFinite(connection?.rtt) ? connection.rtt : null,
    saveData: connection?.saveData === true,
  };
}

function usePhoneConnection() {
  const [snapshot, setSnapshot] = useState(readPhoneConnection);

  useEffect(() => {
    const connection = navigator.connection
      || navigator.mozConnection
      || navigator.webkitConnection
      || null;
    const update = () => setSnapshot(readPhoneConnection());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    connection?.addEventListener?.('change', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      connection?.removeEventListener?.('change', update);
    };
  }, []);

  return snapshot;
}

function trackerTransportLabel(connectivity, t) {
  if (connectivity?.transport === 'wifi') return t.connectionWifi;
  if (connectivity?.transport === 'cellular') {
    return connectivity.generation
      ? t.connectionCellularGeneration(String(connectivity.generation).toUpperCase())
      : t.connectionCellular;
  }
  return t.connectionUnknown;
}

function phoneTransportLabel(connection, t) {
  if (!connection.online) return t.offline;
  if (connection.type === 'wifi') return t.connectionWifi;
  if (connection.type === 'cellular') return t.phoneMobileData;
  if (connection.type === 'ethernet') return t.phoneEthernet;
  if (connection.type && !['unknown', 'other'].includes(connection.type)) {
    return connection.type;
  }
  return t.phoneInternetAvailable;
}

function signalDescription(signal, t) {
  if (!Number.isFinite(Number(signal))) return t.signalUnavailable;
  const dbm = Number(signal);
  const quality = dbm >= -55
    ? t.signalExcellent
    : dbm >= -67
      ? t.signalGood
      : dbm >= -75
        ? t.signalFair
        : t.signalWeak;
  return `${quality} · ${dbm} dBm`;
}

function trackerProfileLabel(connectivity, t) {
  if (connectivity?.label === 'phone_hotspot') return t.profilePhoneHotspot;
  if (connectivity?.label === 'home_wifi') return t.profileHomeWifi;
  if (connectivity?.label === 'farm_kafe') return t.profileFarmKafe;
  if (connectivity?.label) return connectivity.label;
  if (connectivity?.transport === 'wifi') return t.networkProfileUnavailable;
  if (connectivity?.transport === 'cellular') return t.carrierUnavailable;
  return t.notAvailable;
}

export default function AccountScreen({
  device, user, tgUser, telegramId, themePref, onThemeChange, onRefresh,
  developerToolsEnabled = false, onOpenDeveloper,
  openFirmwareUpdate = false, onFirmwareUpdateOpened,
}) {
  const { t, lang, setLang } = useLanguage();
  const toast = useToast();

  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [invoice, setInvoice] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [paid, setPaid] = useState(false);
  const [expired, setExpired] = useState(false);
  const [creating, setCreating] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [firmwareUpdateOpen, setFirmwareUpdateOpen] = useState(openFirmwareUpdate);
  const [wifiOpen, setWifiOpen] = useState(false);
  const [wifiData, setWifiData] = useState(null);
  const [wifiLoading, setWifiLoading] = useState(false);
  const [wifiFormOpen, setWifiFormOpen] = useState(false);
  const [wifiForm, setWifiForm] = useState(EMPTY_WIFI_FORM);
  const [wifiSaving, setWifiSaving] = useState(false);
  const [showWifiPassword, setShowWifiPassword] = useState(false);
  const [deleteWifiId, setDeleteWifiId] = useState(null);
  const pollRef = useRef(null);
  const phoneConnection = usePhoneConnection();

  useEffect(() => {
    if (!openFirmwareUpdate) return;
    setFirmwareUpdateOpen(true);
    onFirmwareUpdateOpened?.();
  }, [openFirmwareUpdate, onFirmwareUpdateOpened]);

  const subActive = subscriptionActive(device?.subscription_expiry);
  const trackerConnection = device?.connectivity ?? {};
  const profileName = user?.display_name
    || [tgUser?.firstName, tgUser?.lastName].filter(Boolean).join(' ')
    || tgUser?.username
    || '—';
  const telegramHandle = user?.telegram_handle || tgUser?.username;
  const trackerOnline = trackerConnection.status === 'online';
  const trackerTransport = trackerTransportLabel(trackerConnection, t);
  const trackerProfile = trackerProfileLabel(trackerConnection, t);
  const gpsReportedFix = device?.latest_telemetry?.gps_fix === 1
    || device?.latest_telemetry?.gps_fix === true;
  const gpsStatus = !trackerOnline ? 'unavailable' : gpsReportedFix ? 'fixed' : 'searching';

  // Render KHQR payload → QR image
  useEffect(() => {
    if (!invoice?.khqr_payload) return;
    QRCode.toDataURL(invoice.khqr_payload, { width: 280, margin: 2 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [invoice]);

  // Poll invoice status until paid / expired
  useEffect(() => {
    if (!invoice?.invoice_ref || paid) return undefined;

    pollRef.current = setInterval(async () => {
      try {
        const { status } = await api.invoiceStatusSecure(invoice.invoice_ref);
        if (status === 'paid') {
          setPaid(true);
          clearInterval(pollRef.current);
          haptic.success();
          onRefresh();
        } else if (status === 'expired') {
          setExpired(true);
          setInvoice(null);
          clearInterval(pollRef.current);
        }
      } catch { /* keep polling */ }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(pollRef.current);
  }, [invoice, paid, onRefresh]);

  const startInvoice = async () => {
    if (!telegramId) {
      toast.error(t.openInTelegramToRenew);
      return;
    }
    setCreating(true);
    setExpired(false);
    haptic.medium();
    try {
      const result = await api.createInvoiceSecure();
      if (result.error) throw new Error(result.error);
      setInvoice(result);
      setPaid(false);
    } catch {
      toast.error(t.connectionError);
    } finally {
      setCreating(false);
    }
  };

  const openInvoiceSheet = () => {
    haptic.light();
    setInvoiceOpen(true);
    if (!invoice && !paid) startInvoice();
  };

  const closeInvoiceSheet = () => {
    setInvoiceOpen(false);
    clearInterval(pollRef.current);
    if (!paid) setInvoice(null); // keep paid hero state only if it was shown
  };

  const loadWifiProfiles = async () => {
    if (!device?.device_id || !telegramId) return;
    setWifiLoading(true);
    try {
      setWifiData(await api.wifiProfiles(device.device_id));
    } catch {
      toast.error(t.wifiLoadFailed);
    } finally {
      setWifiLoading(false);
    }
  };

  const openWifiManager = () => {
    haptic.light();
    setConnectionOpen(false);
    setWifiOpen(true);
    setWifiFormOpen(false);
    setDeleteWifiId(null);
    loadWifiProfiles();
  };

  const startAddWifi = () => {
    setWifiForm(EMPTY_WIFI_FORM);
    setShowWifiPassword(false);
    setWifiFormOpen(true);
    haptic.light();
  };

  const startEditWifi = (profile) => {
    setWifiForm({
      id: profile.id,
      version: profile.version,
      label: profile.label,
      ssid: profile.ssid ?? '',
      password: '',
      priority: profile.priority,
    });
    setShowWifiPassword(false);
    setWifiFormOpen(true);
    setDeleteWifiId(null);
    haptic.light();
  };

  const saveWifiProfile = async (event) => {
    event.preventDefault();
    if (wifiSaving) return;
    setWifiSaving(true);
    haptic.medium();
    const body = {
      label: wifiForm.label,
      ssid: wifiForm.ssid,
      priority: Number(wifiForm.priority),
    };
    if (!wifiForm.id || wifiForm.password) body.password = wifiForm.password;
    if (wifiForm.id) body.version = wifiForm.version;
    try {
      if (wifiForm.id) await api.updateWifiProfile(wifiForm.id, body);
      else await api.createWifiProfile(device.device_id, body);
      toast.success(t.wifiSaved);
      haptic.success();
      setWifiFormOpen(false);
      setWifiForm(EMPTY_WIFI_FORM);
      await loadWifiProfiles();
    } catch {
      toast.error(t.wifiSaveFailed);
      haptic.error();
    } finally {
      setWifiSaving(false);
    }
  };

  const removeWifiProfile = async (profile) => {
    if (deleteWifiId !== profile.id) {
      setDeleteWifiId(profile.id);
      haptic.medium();
      return;
    }
    try {
      await api.archiveWifiProfile(profile.id, profile.version);
      toast.success(t.wifiDeleted);
      haptic.success();
      setDeleteWifiId(null);
      await loadWifiProfiles();
    } catch {
      toast.error(t.wifiSaveFailed);
      haptic.error();
    }
  };

  return (
    <div className="screen">
      {/* ---- Profile ---- */}
      {(user || tgUser) && (
        <section className="card profile-card">
          <UserAvatar photoUrl={tgUser?.photoUrl} name={profileName} className="profile-avatar" />
          <div className="profile-copy">
            <h2>{profileName}</h2>
            {telegramHandle && <p>@{telegramHandle}</p>}
          </div>
        </section>
      )}

      {/* ---- Subscription ---- */}
      <section className="card">
        <h2><CardIcon />{t.subscription}</h2>

        <div className={`sub-status ${subActive ? '' : 'inactive'}`}>
          <div>
            <div className="sub-label">{subActive ? t.expires : t.noExpiry}</div>
            <div className="sub-date">
              {subActive ? fmtDateLong(device.subscription_expiry) : '—'}
            </div>
          </div>
          <span className={`pill ${subActive ? '' : 'inactive'}`}>
            {subActive ? t.active : t.inactive}
          </span>
        </div>

        <button className="btn primary" onClick={openInvoiceSheet} disabled={!telegramId}>
          <CardIcon />
          {t.extendBtn}
        </button>

        <div className="secure-note">
          <LockIcon />
          {t.securePayment}
        </div>
      </section>

      {/* ---- Device ---- */}
      {device && (
        <section className="card">
          <h2><BikeIcon />{t.device}</h2>
          <div className="row-list">
            <div className="row-item">
              <span className="row-label">{t.deviceIdLabel}</span>
              <span className="row-value"><code>{device.device_id}</code></span>
            </div>
            {device.firmware_version && (
              <div className="row-item">
                <span className="row-label">{t.firmware}</span>
                <span className="row-value">{device.firmware_version}</span>
              </div>
            )}
            <div className="row-item">
              <span className="row-label">{t.lastSeen}</span>
              <span className="row-value">{timeAgo(device.latest_telemetry?.received_at, t)}</span>
            </div>
          </div>
        </section>
      )}

      {/* ---- Settings ---- */}
      <section className="card">
        <h2>{t.settings}</h2>

        {developerToolsEnabled && (
          <button
            className="settings-link developer-link"
            type="button"
            onClick={() => { haptic.medium(); onOpenDeveloper?.(); }}
          >
            <span className="settings-link-icon"><ToolsIcon /></span>
            <span className="settings-link-copy">
              <strong>{t.developerTitle}</strong>
              <small>{t.developerAccountDescription}</small>
            </span>
            <ChevronRightIcon className="settings-chevron" />
          </button>
        )}

        <button
          className="settings-link firmware-update-link"
          type="button"
          onClick={() => { setFirmwareUpdateOpen(true); haptic.light(); }}
        >
          <span className="settings-link-icon firmware"><RefreshIcon /></span>
          <span className="settings-link-copy">
            <strong>{t.firmwareUpdateTitle}</strong>
            <small>{t.firmwareUpdateAccountDescription}</small>
          </span>
          <ChevronRightIcon className="settings-chevron" />
        </button>

        <button
          className="settings-link"
          type="button"
          onClick={() => { setConnectionOpen(true); haptic.light(); }}
        >
          <span className={`settings-link-icon ${trackerOnline ? 'online' : 'offline'}`}>
            <WifiIcon />
          </span>
          <span className="settings-link-copy">
            <strong>{t.connectionDetails}</strong>
            <small>
              {trackerOnline ? trackerTransport : t.trackerOffline}
              {trackerConnection.label ? ` · ${trackerProfile}` : ''}
            </small>
          </span>
          <ChevronRightIcon className="settings-chevron" />
        </button>

        <div className="field-label">{t.language}</div>
        <div className="segmented">
          <button
            className={`seg-btn ${lang === 'en' ? 'active' : ''}`}
            onClick={() => { setLang('en'); haptic.select(); }}
          >
            {t.english}
          </button>
          <button
            className={`seg-btn ${lang === 'km' ? 'active' : ''}`}
            onClick={() => { setLang('km'); haptic.select(); }}
          >
            {t.khmer}
          </button>
        </div>

        <div className="field-label">{t.theme}</div>
        <div className="segmented">
          {[
            ['auto', t.themeAuto],
            ['light', t.themeLight],
            ['dark', t.themeDark],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`seg-btn ${themePref === key ? 'active' : ''}`}
              onClick={() => { onThemeChange(key); haptic.select(); }}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <FirmwareUpdateSheet
        open={firmwareUpdateOpen}
        onClose={() => setFirmwareUpdateOpen(false)}
        device={device}
        onUpdated={onRefresh}
      />

      {/* ---- Connection details sheet ---- */}
      <Sheet open={connectionOpen} onClose={() => setConnectionOpen(false)} closeLabel={t.cancel}>
        <div className="sheet-title"><WifiIcon />{t.connectionDetails}</div>
        <p className="sheet-body">{t.connectionDetailsBody}</p>

        <div className="connection-route" aria-label={t.connectionRouteLabel}>
          <div className={`route-node ${trackerOnline ? 'active' : 'offline'}`}>
            <BikeIcon />
            <span>{t.tracker}</span>
          </div>
          <span className={`route-link ${trackerOnline ? 'active' : 'offline'}`} />
          <div className={`route-node ${trackerOnline && phoneConnection.online ? 'active' : ''}`}>
            <CloudIcon />
            <span>{t.bikeBossCloud}</span>
          </div>
          <span className={`route-link ${phoneConnection.online ? 'active' : 'offline'}`} />
          <div className={`route-node ${phoneConnection.online ? 'active' : 'offline'}`}>
            <PhoneIcon />
            <span>{t.thisPhone}</span>
          </div>
        </div>

        <section className="connection-panel">
          <div className="connection-panel-head">
            <span className="connection-panel-icon"><BikeIcon /></span>
            <div>
              <strong>{t.trackerInternet}</strong>
              <small>{t.trackerInternetBody}</small>
            </div>
            <span className={`connection-status ${trackerOnline ? 'online' : 'offline'}`}>
              {trackerOnline ? t.online : t.offline}
            </span>
          </div>
          <div className="connection-rows">
            <div><span>{t.connectionType}</span><strong>{trackerTransport}</strong></div>
            <div><span>{t.networkProfile}</span><strong>{trackerProfile}</strong></div>
            <div>
              <span>{t.signalStrength}</span>
              <strong>{signalDescription(trackerConnection.signal_dbm, t)}</strong>
            </div>
            <div>
              <span>{t.lastHeartbeat}</span>
              <strong>{timeAgo(trackerConnection.last_seen_at, t)}</strong>
            </div>
            <div>
              <span>{t.gpsReceiver}</span>
              <strong className={gpsStatus === 'fixed' ? 'value-good' : ''}>
                {gpsStatus === 'fixed'
                  ? t.gpsFixReady
                  : gpsStatus === 'searching' ? t.gpsWaiting : t.gpsUnavailable}
              </strong>
            </div>
          </div>
        </section>

        <button className="wifi-manage-card" type="button" onClick={openWifiManager}>
          <span className="connection-panel-icon"><WifiIcon /></span>
          <span>
            <strong>{t.trustedWifi}</strong>
            <small>{t.trustedWifiSummary}</small>
          </span>
          <span className="wifi-manage-action">{t.manageNetworks}</span>
        </button>

        <section className="connection-panel">
          <div className="connection-panel-head">
            <span className="connection-panel-icon phone"><PhoneIcon /></span>
            <div>
              <strong>{t.phoneInternet}</strong>
              <small>{t.phoneInternetBody}</small>
            </div>
            <span className={`connection-status ${phoneConnection.online ? 'online' : 'offline'}`}>
              {phoneConnection.online ? t.online : t.offline}
            </span>
          </div>
          <div className="connection-rows">
            <div><span>{t.connectionType}</span><strong>{phoneTransportLabel(phoneConnection, t)}</strong></div>
            <div>
              <span>{t.networkQuality}</span>
              <strong>
                {phoneConnection.effectiveType
                  ? String(phoneConnection.effectiveType).toUpperCase()
                  : t.notAvailable}
              </strong>
            </div>
            {phoneConnection.downlink != null && (
              <div><span>{t.estimatedDownlink}</span><strong>{phoneConnection.downlink} Mbps</strong></div>
            )}
            {phoneConnection.rtt != null && (
              <div><span>{t.estimatedLatency}</span><strong>{phoneConnection.rtt} ms</strong></div>
            )}
            <div><span>{t.networkName}</span><strong>{t.hiddenByTelegram}</strong></div>
          </div>
        </section>

        <div className="connection-note">
          <SatelliteIcon />
          <div><strong>{t.gpsWorksOffline}</strong><span>{t.gpsWorksOfflineBody}</span></div>
        </div>
        <div className="connection-note privacy">
          <InfoIcon />
          <div><strong>{t.connectionPrivacy}</strong><span>{t.connectionPrivacyBody}</span></div>
        </div>

        <div className="sheet-actions">
          <button className="btn primary" onClick={() => setConnectionOpen(false)}>{t.done}</button>
        </div>
      </Sheet>

      {/* ---- Trusted Wi-Fi manager ---- */}
      <Sheet open={wifiOpen} onClose={() => setWifiOpen(false)} closeLabel={t.cancel}>
        <div className="sheet-title"><WifiIcon />{t.trustedWifi}</div>
        <p className="sheet-body">{t.trustedWifiBody}</p>

        <div className={`wifi-sync-banner ${wifiData?.sync?.status === 'synced' ? 'synced' : 'pending'}`}>
          <span className="wifi-sync-dot" />
          <div>
            <strong>{wifiData?.sync?.status === 'synced' ? t.syncComplete : t.syncPending}</strong>
            <small>{t.wifiProfileLimit}</small>
          </div>
          {wifiData && <code>{wifiData.sync.applied_revision}/{wifiData.sync.revision}</code>}
        </div>

        {wifiLoading && (
          <div className="wifi-list">
            <div className="wifi-profile-card skeleton"><div className="sk sk-title" /><div className="sk sk-line" /></div>
            <div className="wifi-profile-card skeleton"><div className="sk sk-title" /><div className="sk sk-line" /></div>
          </div>
        )}

        {!wifiLoading && wifiData?.profiles?.length === 0 && (
          <div className="wifi-empty">
            <span><WifiIcon /></span>
            <strong>{t.wifiProfilesEmpty}</strong>
            <p>{t.wifiProfilesEmptyBody}</p>
          </div>
        )}

        {!wifiLoading && wifiData?.profiles?.length > 0 && (
          <div className="wifi-list">
            {wifiData.profiles.map((profile) => {
              const connected = trackerConnection.profile_id === profile.id
                || trackerConnection.label === profile.label;
              return (
                <article className={`wifi-profile-card ${connected ? 'connected' : ''}`} key={profile.id}>
                  <div className="wifi-profile-main">
                    <span className="wifi-profile-icon"><WifiIcon /></span>
                    <div>
                      <strong>{profile.label}</strong>
                      <small>{profile.ssid || t.notAvailable}</small>
                    </div>
                    {connected && <span className="wifi-current">{t.connectedNow}</span>}
                  </div>
                  <div className="wifi-profile-meta">
                    <span><SignalIcon />{profile.priority >= 70 ? t.priorityPreferred : profile.priority <= 30 ? t.priorityBackup : t.priorityNormal}</span>
                    <span>{profile.last_connected_at ? `${t.lastConnected} ${timeAgo(profile.last_connected_at, t)}` : t.learningArea}</span>
                    {profile.learned_location && (
                      <span>{t.learnedArea} · {profile.learned_location.lat.toFixed(4)}, {profile.learned_location.lon.toFixed(4)}</span>
                    )}
                  </div>
                  {!wifiData.read_only && (
                    <div className="wifi-profile-actions">
                      <button type="button" onClick={() => startEditWifi(profile)}><EditIcon />{t.editWifiNetwork}</button>
                      <button
                        type="button"
                        className={deleteWifiId === profile.id ? 'confirm' : 'danger-text'}
                        onClick={() => removeWifiProfile(profile)}
                      >
                        <TrashIcon />{deleteWifiId === profile.id ? t.confirmDeleteNetwork : t.deleteNetwork}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {wifiData?.read_only && <div className="connection-note privacy"><InfoIcon /><div><strong>{t.wifiReadOnly}</strong></div></div>}

        {!wifiData?.read_only && !wifiFormOpen && (
          <button
            className="btn primary"
            type="button"
            onClick={startAddWifi}
            disabled={!wifiData || wifiData.profiles.length >= wifiData.maximum_profiles}
          >
            <WifiIcon />{t.addWifiNetwork}
          </button>
        )}

        {wifiFormOpen && (
          <form className="wifi-form" onSubmit={saveWifiProfile}>
            <div className="wifi-form-head">
              <strong>{wifiForm.id ? t.editWifiNetwork : t.addWifiNetwork}</strong>
              <button type="button" onClick={() => setWifiFormOpen(false)}>{t.cancel}</button>
            </div>
            <label>
              <span>{t.wifiLabel}</span>
              <input
                className="text-input"
                value={wifiForm.label}
                onChange={(event) => setWifiForm((current) => ({ ...current, label: event.target.value }))}
                placeholder={t.wifiLabelPlaceholder}
                maxLength={40}
                required
              />
            </label>
            <label>
              <span>{t.wifiSsid}</span>
              <input
                className="text-input"
                value={wifiForm.ssid}
                onChange={(event) => setWifiForm((current) => ({ ...current, ssid: event.target.value }))}
                placeholder={t.wifiSsidPlaceholder}
                maxLength={32}
                required
                autoCapitalize="none"
                autoCorrect="off"
              />
            </label>
            <label>
              <span>{t.wifiPassword}</span>
              <div className="password-field">
                <input
                  className="text-input"
                  type={showWifiPassword ? 'text' : 'password'}
                  value={wifiForm.password}
                  onChange={(event) => setWifiForm((current) => ({ ...current, password: event.target.value }))}
                  placeholder={wifiForm.id ? t.wifiPasswordUnchanged : '••••••••'}
                  minLength={wifiForm.id && !wifiForm.password ? undefined : 8}
                  maxLength={63}
                  required={!wifiForm.id}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                <button type="button" onClick={() => setShowWifiPassword((value) => !value)}>
                  {showWifiPassword ? t.hidePassword : t.showPassword}
                </button>
              </div>
            </label>
            <label>
              <span>{t.wifiPriority}</span>
              <select
                className="text-input"
                value={wifiForm.priority}
                onChange={(event) => setWifiForm((current) => ({ ...current, priority: Number(event.target.value) }))}
              >
                <option value="80">{t.priorityPreferred}</option>
                <option value="50">{t.priorityNormal}</option>
                <option value="20">{t.priorityBackup}</option>
              </select>
            </label>
            <div className="connection-note privacy"><LockIcon /><div><span>{t.wifiSecurityNote}</span></div></div>
            <button className="btn primary" type="submit" disabled={wifiSaving}>
              {wifiSaving ? <><RefreshIcon className="spin" />{t.savingNetwork}</> : t.saveNetwork}
            </button>
          </form>
        )}

        <div className="cellular-fallback-card">
          <span><SignalIcon /></span>
          <div><strong>{t.cellularFallback}</strong><p>{t.cellularFallbackBody}</p></div>
        </div>

        <div className="sheet-actions">
          <button className="btn secondary" onClick={() => setWifiOpen(false)}>{t.done}</button>
        </div>
      </Sheet>

      {/* ---- Invoice sheet ---- */}
      <Sheet open={invoiceOpen} onClose={closeInvoiceSheet} closeLabel={t.cancel}>
        {paid ? (
          <div className="paid-hero">
            <div className="paid-ring"><CheckCircleIcon /></div>
            <h3>{t.paymentConfirmed}</h3>
            <p>{t.paymentConfirmedBody}</p>
            <div className="sheet-actions" style={{ width: '100%' }}>
              <button className="btn primary" onClick={closeInvoiceSheet}>{t.done}</button>
            </div>
          </div>
        ) : (
          <>
            <div className="sheet-title"><CardIcon />{t.invoiceTitle}</div>

            {creating && (
              <div className="skeleton">
                <div className="sk" style={{ height: 32, width: 140, margin: '0 auto' }} />
                <div className="sk" style={{ height: 232, width: 232, margin: '0 auto', borderRadius: 20 }} />
                <div className="sk sk-title" style={{ margin: '0 auto', width: 160 }} />
              </div>
            )}

            {expired && !invoice && !creating && (
              <>
                <p className="sheet-body">{t.invoiceExpired}</p>
                <div className="sheet-actions">
                  <button className="btn primary" onClick={startInvoice}>
                    <RefreshIcon />
                    {t.newInvoice}
                  </button>
                  <button className="btn ghost primary" onClick={closeInvoiceSheet}>{t.cancel}</button>
                </div>
              </>
            )}

            {invoice && !creating && (
              <>
                <div className="invoice">
                  <p className="amount-big">${invoice.amount_usd.toFixed(2)}</p>
                  <p className="hint">{t.scanWith}</p>
                  {qrDataUrl ? (
                    <img className="qr-img" src={qrDataUrl} alt="KHQR payment code" />
                  ) : invoice.payway_link ? (
                    <a className="btn" href={invoice.payway_link} target="_blank" rel="noreferrer">
                      {t.payViaLink}
                    </a>
                  ) : null}
                  <div className="invoice-meta">
                    <span className="ref-chip">{invoice.invoice_ref}</span>
                    <span className="label">
                      {t.expires}: {new Date(invoice.expires_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="waiting">
                    <span className="spinner" />
                    {t.waitingPayment}
                  </div>
                </div>
                <div className="sheet-actions">
                  <button className="btn ghost primary" onClick={closeInvoiceSheet}>{t.done}</button>
                </div>
                <div className="secure-note"><LockIcon />{t.securePayment}</div>
              </>
            )}
          </>
        )}
      </Sheet>
    </div>
  );
}
