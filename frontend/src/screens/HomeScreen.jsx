import { useEffect, useRef, useState } from 'react';
import { api, haptic } from '../api.js';
import { useLanguage } from '../components/LanguageProvider.jsx';
import { useToast } from '../components/Toast.jsx';
import Sheet from '../components/Sheet.jsx';
import { timeAgo } from '../format.js';
import {
  ShieldIcon, ShieldOffIcon, LockIcon, UnlockIcon,
  BatteryIcon, GaugeIcon, SatelliteIcon, ClockIcon,
  PinIcon, ExternalIcon, AlertIcon, RefreshIcon, CheckCircleIcon, InfoIcon,
} from '../components/icons.jsx';

const OFFLINE_AFTER_MS = 5 * 60 * 1000;

function isOnline(latest) {
  if (!latest?.received_at) return false;
  return Date.now() - new Date(`${latest.received_at}Z`).getTime() < OFFLINE_AFTER_MS;
}

function batteryClass(v) {
  if (v == null) return '';
  if (v >= 11.8) return 'ok';
  if (v >= 11.0) return 'warn';
  return 'bad';
}

export default function HomeScreen({ device, latest, geofences, tgUser, onRefresh, onNavigate }) {
  const { t } = useLanguage();
  const toast = useToast();
  const [sheet, setSheet] = useState(null); // 'arm' | 'disarm'
  const [sending, setSending] = useState(false);
  const [pendingCommand, setPendingCommand] = useState(null);
  const commandStartedAt = useRef(null);

  // arm_state: 0 disarmed · 1 armed · 2 pending-unlock
  const armState = latest?.arm_state ?? device?.arm_state ?? 0;
  const stateClass = armState === 1 ? 'armed' : armState === 2 ? 'pending' : 'disarmed';
  const online = device?.connectivity?.online ?? isOnline(latest);
  const vbat = latest?.vbat ?? null;
  const reportedGpsFix = !!latest?.gps_fix;
  const gpsStatus = !online ? 'unavailable' : reportedGpsFix ? 'fixed' : 'searching';
  const hasCoordinates = Number.isFinite(Number(latest?.gps_lat))
    && Number.isFinite(Number(latest?.gps_lon))
    && !(Number(latest?.gps_lat) === 0 && Number(latest?.gps_lon) === 0);
  const activeFence = geofences?.find((zone) => (zone.status ?? 'active') === 'active') ?? null;
  const activeFenceName = activeFence?.name ?? activeFence?.label;
  const activeFenceRadius = activeFence?.geometry?.radius_m ?? activeFence?.radius_m;
  const sharedPrototype = device?.connection_mode === 'shared_prototype';
  const hardwareCommandsEnabled = device?.capabilities?.hardware_commands !== false;

  const sendCommand = async (action) => {
    if (!hardwareCommandsEnabled) {
      toast.info(t.sharedPrototypeControlLocked);
      return;
    }
    setSending(true);
    haptic.medium();
    try {
      if (!tgUser?.initData) throw new Error('telegram_session_required');
      const result = await api.deviceCommandSecure(device.device_id, action);
      commandStartedAt.current = Date.now();
      setPendingCommand(result.command);
      setSheet('command');
      toast.info(t.commandQueued);
    } catch {
      toast.error(t.commandFailed);
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!pendingCommand?.id || ['applied', 'failed'].includes(pendingCommand.uiStatus)) return undefined;
    const poll = async () => {
      try {
        const result = await api.commandStatus(device.device_id, pendingCommand.id);
        const command = result.command;
        const uiStatus = command.status === 'acked' ? command.ack_status : command.status;
        setPendingCommand({ ...command, uiStatus });
        if (uiStatus === 'applied') {
          toast.success(t.command_applied);
          haptic.success();
          await onRefresh();
        } else if (uiStatus === 'failed') {
          toast.error(t.command_failed);
          haptic.error();
        }
      } catch { /* retain the last durable command state and poll again */ }
    };
    const timer = setInterval(poll, 2_000);
    poll();
    return () => clearInterval(timer);
  }, [device.device_id, onRefresh, pendingCommand?.id, pendingCommand?.uiStatus, t, toast]);

  const commandUiStatus = pendingCommand?.uiStatus ?? pendingCommand?.status ?? 'pending';
  const commandTimedOut = !!pendingCommand
    && commandStartedAt.current
    && Date.now() - commandStartedAt.current > 45_000
    && !['applied', 'failed'].includes(commandUiStatus);

  return (
    <div className="screen">
      {sharedPrototype && (
        <aside className="prototype-notice" role="status">
          <InfoIcon />
          <div>
            <strong>{t.sharedPrototypeTitle}</strong>
            <p>{t.sharedPrototypeBody}</p>
          </div>
        </aside>
      )}

      {/* ---- Security status hero ---- */}
      <section className={`security-hero ${stateClass}`}>
        <span className={`connectivity ${online ? 'online' : ''}`}>
          {online ? t.controllerOnline : t.controllerOffline}
        </span>
        <div className="security-hero-top">
          <div className="shield-ring">
            {armState === 1 ? <ShieldIcon /> : armState === 2 ? <ClockIcon /> : <ShieldOffIcon />}
          </div>
          <div>
            <div className="security-state">
              {armState === 1 ? t.armed : armState === 2 ? t.pendingUnlock : t.disarmed}
            </div>
            <div className="security-sub">
              {armState === 1 ? t.protected : armState === 2 ? t.pendingState : t.unprotected}
            </div>
          </div>
        </div>

        {!hardwareCommandsEnabled ? (
          <button className="arm-action pending" disabled>
            <LockIcon />
            {t.sharedPrototypeControlLocked}
          </button>
        ) : armState === 2 ? (
          <button className="arm-action pending" disabled>
            <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2.5 }} />
            {t.pendingUnlock}
          </button>
        ) : armState === 0 ? (
          <button
            className="arm-action arm"
            onClick={() => { haptic.light(); setSheet('arm'); }}
          >
            <LockIcon />
            {t.armBtn}
          </button>
        ) : (
          <button
            className="arm-action disarm"
            onClick={() => { haptic.light(); setSheet('disarm'); }}
          >
            <UnlockIcon />
            {t.disarmBtn}
          </button>
        )}
      </section>

      {/* ---- Vitals ---- */}
      <section className="card">
        <div className="card-title">
          <h2>{t.myBike}</h2>
          <button className="refresh-btn" onClick={() => { haptic.light(); onRefresh(); }} aria-label="Refresh">
            <RefreshIcon />
          </button>
        </div>
        <div className="grid">
          <div className="stat">
            <span className="stat-head"><BatteryIcon />{t.battery}</span>
            <span className={`value ${batteryClass(vbat)} ${vbat == null ? 'small' : ''}`}>
              {vbat != null ? `${vbat.toFixed(1)} V` : t.batteryNotMeasured}
            </span>
            {vbat != null && (
              <div className="batt-track">
                <div
                  className={`batt-fill ${batteryClass(vbat)}`}
                  style={{ width: `${Math.max(5, Math.min(100, ((vbat - 10.5) / 2.4) * 100))}%` }}
                />
              </div>
            )}
          </div>
          <div className="stat">
            <span className="stat-head"><GaugeIcon />{t.speed}</span>
            <span className="value">
              {latest?.gps_speed != null ? `${Number(latest.gps_speed).toFixed(0)} km/h` : '—'}
            </span>
          </div>
          <div className="stat">
            <span className="stat-head"><SatelliteIcon />{t.gps}</span>
            <span className={`value ${gpsStatus === 'fixed' ? 'ok' : gpsStatus === 'searching' ? 'warn' : 'small'}`}>
              {gpsStatus === 'fixed'
                ? t.gpsFixed
                : gpsStatus === 'searching' ? t.gpsNoFix : t.gpsUnavailable}
            </span>
          </div>
          <div className="stat">
            <span className="stat-head"><ClockIcon />{t.lastSeen}</span>
            <span className="value small">{timeAgo(latest?.received_at, t)}</span>
          </div>
        </div>
      </section>

      {/* ---- Location & geofence ---- */}
      <section className="card">
        <h2><PinIcon />{t.location}</h2>

        {hasCoordinates ? (
          <>
            {gpsStatus !== 'fixed' && <p className="hint">{t.lastKnownLocation}</p>}
            <div className="coords">
              <span className="coord-chip">{latest.gps_lat?.toFixed(6)}</span>
              <span className="coord-chip">{latest.gps_lon?.toFixed(6)}</span>
            </div>
            <a
              className="btn ghost"
              href={`https://maps.google.com/?q=${latest.gps_lat},${latest.gps_lon}`}
              target="_blank"
              rel="noreferrer"
              onClick={() => haptic.light()}
            >
              <ExternalIcon />
              {t.openInMaps}
            </a>
          </>
        ) : (
          <div className="empty-state">
            <SatelliteIcon />
            <p>{t.noGpsFix}</p>
          </div>
        )}

        {activeFence ? (
          <div className="geofence-row">
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <ShieldIcon />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.geofenceActive(activeFenceName, Math.round(activeFenceRadius))}
              </span>
            </span>
            <span className="geofence-radius">{Math.round(activeFenceRadius)} m</span>
          </div>
        ) : (
          <p className="hint">{t.geofenceNone}</p>
        )}

        <button className="btn ghost" onClick={() => { haptic.medium(); onNavigate?.('map'); }}>
          <ShieldIcon />
          {t.manageSafeZones}
        </button>
      </section>

      {/* ---- Arm / disarm confirmation sheets ---- */}
      <Sheet open={sheet === 'arm'} onClose={() => setSheet(null)} closeLabel={t.cancel}>
        <div className="sheet-title danger">
          <LockIcon />
          {t.armConfirmTitle}
        </div>
        <p className="sheet-body">{t.armConfirmBody}</p>
        <div className="sheet-actions">
          <button
            className="btn danger primary"
            onClick={() => sendCommand('ARM')}
            disabled={sending}
          >
            {sending && <span className="spinner" style={{ width: 15, height: 15, borderWidth: 2 }} />}
            {t.confirmArm}
          </button>
          <button className="btn ghost primary" onClick={() => setSheet(null)} disabled={sending}>
            {t.cancel}
          </button>
        </div>
      </Sheet>

      <Sheet open={sheet === 'disarm'} onClose={() => setSheet(null)} closeLabel={t.cancel}>
        <div className="sheet-title success">
          <UnlockIcon />
          {t.disarmConfirmTitle}
        </div>
        <p className="sheet-body">{t.disarmConfirmBody}</p>
        <div className="sheet-actions">
          <button
            className="btn success primary"
            onClick={() => sendCommand('DISARM')}
            disabled={sending}
          >
            {sending && <span className="spinner" style={{ width: 15, height: 15, borderWidth: 2 }} />}
            {t.confirmDisarm}
          </button>
          <button className="btn ghost primary" onClick={() => setSheet(null)} disabled={sending}>
            {t.cancel}
          </button>
        </div>
      </Sheet>

      <Sheet
        open={sheet === 'command'}
        closeLabel={t.cancel}
        onClose={() => {
          setSheet(null);
          if (['applied', 'failed'].includes(commandUiStatus)) setPendingCommand(null);
        }}
      >
        <div className={`command-status-hero ${commandUiStatus}`}>
          <span>
            {commandUiStatus === 'applied' ? <CheckCircleIcon />
              : commandUiStatus === 'failed' ? <AlertIcon /> : <RefreshIcon />}
          </span>
          <div>
            <small>{t.commandPendingTitle}</small>
            <h2>{t[`command_${commandUiStatus}`] ?? t.command_pending}</h2>
          </div>
        </div>
        <div className="command-timeline">
          {['pending', 'delivered', 'applied'].map((status, index) => {
            const rank = { pending: 0, delivered: 1, applied: 2, failed: 2 };
            const active = rank[commandUiStatus] >= index;
            const failed = status === 'applied' && commandUiStatus === 'failed';
            return (
              <div className={`${active ? 'active' : ''} ${failed ? 'failed' : ''}`} key={status}>
                <span>{failed ? <AlertIcon /> : active ? <CheckCircleIcon /> : <ClockIcon />}</span>
                <strong>{t[`command_${failed ? 'failed' : status}`]}</strong>
              </div>
            );
          })}
        </div>
        <p className="sheet-body">{commandTimedOut ? t.commandTimedOut : t.commandWaiting}</p>
        <button className="btn ghost primary" onClick={() => setSheet(null)}>{t.done}</button>
      </Sheet>
    </div>
  );
}

/** Connection-failure state with retry — used by the shell. */
export function ErrorState({ onRetry }) {
  const { t } = useLanguage();
  return (
    <div className="screen">
      <div className="error-state">
        <AlertIcon />
        <p>{t.connectionError}</p>
        <button className="btn" onClick={() => { haptic.light(); onRetry(); }}>
          <RefreshIcon />
          {t.retry}
        </button>
      </div>
    </div>
  );
}
