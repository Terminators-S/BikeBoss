import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, haptic } from '../api.js';
import { useLanguage } from '../components/LanguageProvider.jsx';
import { useToast } from '../components/Toast.jsx';
import { timeAgo } from '../format.js';
import {
  AlertIcon, BatteryIcon, CheckCircleIcon, ClockIcon, ExternalIcon,
  GaugeIcon, InfoIcon, PinIcon, RefreshIcon, RouteIcon, SatelliteIcon,
  ShieldIcon, SignalIcon, ToolsIcon, WifiIcon, XIcon,
} from '../components/icons.jsx';

const POLL_MS = 4_000;
const MAX_SNAPSHOTS = 20;

function storageKey(deviceId) {
  return `bikeboss_field_lab_v1:${deviceId}`;
}

function newSession() {
  return {
    active: false,
    startedAt: null,
    finishedAt: null,
    results: {},
    notes: {},
    snapshots: [],
  };
}

function loadSession(deviceId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(deviceId)) || 'null');
    return parsed && typeof parsed === 'object'
      ? { ...newSession(), ...parsed }
      : newSession();
  } catch {
    return newSession();
  }
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function gpsHasFix(latest) {
  return Boolean(latest?.gps_fix)
    && finite(latest?.gps_lat) != null
    && finite(latest?.gps_lon) != null;
}

function snapshotFrom(live) {
  const latest = live.latest_telemetry ?? {};
  const connectivity = live.connectivity ?? {};
  return {
    captured_at: new Date().toISOString(),
    controller: connectivity.status ?? 'unknown',
    heartbeat_at: connectivity.last_seen_at ?? latest.received_at ?? null,
    uplink: connectivity.transport ?? latest.uplink_type ?? 'unknown',
    signal_dbm: finite(connectivity.signal_dbm ?? latest.uplink_signal_dbm),
    gps_fix: Boolean(latest.gps_fix),
    gps_lat: finite(latest.gps_lat),
    gps_lon: finite(latest.gps_lon),
    gps_accuracy_m: finite(latest.gps_accuracy_m),
    gps_hdop: finite(latest.gps_hdop),
    gps_satellites: finite(latest.gps_satellites),
    gps_speed_kmh: finite(latest.gps_speed),
    motion_state: latest.motion_state ?? null,
    crash_stage: finite(latest.crash_stage),
    arm_state: finite(latest.arm_state),
    battery_v: finite(latest.vbat),
    sequence: finite(latest.sequence),
  };
}

function resultLabel(result, t) {
  if (result === 'pass') return t.developerPass;
  if (result === 'fail') return t.developerFail;
  return t.developerPending;
}

export default function DeveloperScreen({ device, isDemo = false, onNavigate, onRefresh }) {
  const { t } = useLanguage();
  const toast = useToast();
  const [live, setLive] = useState(() => ({
    device,
    latest_telemetry: device?.latest_telemetry ?? null,
    connectivity: device?.connectivity ?? {},
    zones: device?.geofences ?? [],
  }));
  const [session, setSession] = useState(() => loadSession(device.device_id));
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(device.device_id), JSON.stringify(session));
    } catch { /* field results still remain in memory when storage is unavailable */ }
  }, [device.device_id, session]);

  const loadLive = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const data = isDemo
        ? await api.deviceStatus(device.device_id)
        : await api.liveDevice(device.device_id);
      setLive(data);
    } catch {
      if (!quiet) toast.error(t.connectionError);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [device.device_id, isDemo, t.connectionError, toast]);

  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') loadLive({ quiet: true });
    };
    refreshVisible();
    const timer = setInterval(refreshVisible, POLL_MS);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refreshVisible);
    };
  }, [loadLive]);

  const latest = live.latest_telemetry ?? device.latest_telemetry ?? {};
  const connectivity = live.connectivity ?? device.connectivity ?? {};
  const controllerOnline = connectivity.status === 'online' || connectivity.online === true;
  const gpsFixed = controllerOnline && gpsHasFix(latest);
  const accuracy = finite(latest.gps_accuracy_m);
  const satellites = finite(latest.gps_satellites);
  const battery = finite(latest.vbat);
  const signal = finite(connectivity.signal_dbm ?? latest.uplink_signal_dbm);
  const suites = t.developerSuites;

  const counts = useMemo(() => {
    const total = suites.reduce((sum, suite) => sum + suite.steps.length, 0);
    const values = Object.values(session.results);
    return {
      total,
      passed: values.filter((value) => value === 'pass').length,
      failed: values.filter((value) => value === 'fail').length,
      completed: values.filter((value) => value === 'pass' || value === 'fail').length,
    };
  }, [session.results, suites]);

  const metrics = [
    {
      id: 'controller', icon: <WifiIcon />, label: t.developerController,
      value: controllerOnline ? t.online : t.offline,
      detail: timeAgo(connectivity.last_seen_at ?? latest.received_at, t),
      tone: controllerOnline ? 'good' : 'bad',
    },
    {
      id: 'gps', icon: <SatelliteIcon />, label: t.gpsReceiver,
      value: !controllerOnline ? t.gpsUnavailable : gpsFixed ? t.gpsFixReady : t.gpsWaiting,
      detail: gpsFixed
        ? t.developerGpsDetail(satellites, accuracy)
        : t.developerNoLiveMeasurement,
      tone: gpsFixed ? 'good' : controllerOnline ? 'warn' : 'bad',
    },
    {
      id: 'uplink', icon: <SignalIcon />, label: t.developerUplink,
      value: connectivity.transport === 'wifi'
        ? t.connectionWifi
        : connectivity.transport === 'cellular' ? t.connectionCellular : t.connectionUnknown,
      detail: signal == null ? t.signalUnavailable : `${signal} dBm`,
      tone: controllerOnline ? 'good' : 'bad',
    },
    {
      id: 'motion', icon: <GaugeIcon />, label: t.developerMotion,
      value: latest.motion_state || t.notAvailable,
      detail: finite(latest.gps_speed) == null ? '—' : `${Math.round(Number(latest.gps_speed))} km/h`,
      tone: latest.motion_state ? 'neutral' : 'warn',
    },
    {
      id: 'battery', icon: <BatteryIcon />, label: t.developerVehiclePower,
      value: battery == null ? t.batteryNotMeasured : `${battery.toFixed(2)} V`,
      detail: battery == null ? t.developerSensorRequired : t.developerMeasured,
      tone: battery == null ? 'warn' : battery >= 11.5 ? 'good' : 'bad',
    },
    {
      id: 'sequence', icon: <RouteIcon />, label: t.developerSequence,
      value: finite(latest.sequence) == null ? '—' : `#${latest.sequence}`,
      detail: latest.captured_at ? timeAgo(latest.captured_at, t) : t.notAvailable,
      tone: finite(latest.sequence) == null ? 'warn' : 'neutral',
    },
  ];

  const setResult = (suiteId, stepIndex, result) => {
    haptic.select();
    const key = `${suiteId}:${stepIndex}`;
    setSession((current) => ({
      ...current,
      results: {
        ...current.results,
        [key]: current.results[key] === result ? 'pending' : result,
      },
    }));
  };

  const setNote = (suiteId, note) => {
    setSession((current) => ({ ...current, notes: { ...current.notes, [suiteId]: note } }));
  };

  const startSession = () => {
    haptic.medium();
    setSession({ ...newSession(), active: true, startedAt: new Date().toISOString() });
    toast.success(t.developerSessionStarted);
  };

  const finishSession = () => {
    haptic.success();
    setSession((current) => ({
      ...current,
      active: false,
      finishedAt: new Date().toISOString(),
    }));
    toast.success(t.developerSessionFinished);
  };

  const captureSnapshot = () => {
    haptic.medium();
    setSession((current) => ({
      ...current,
      snapshots: [...current.snapshots, snapshotFrom(live)].slice(-MAX_SNAPSHOTS),
    }));
    toast.success(t.developerSnapshotSaved);
  };

  const buildReport = () => {
    const lines = [
      `BikeBoss ${t.developerTitle}`,
      `${t.developerDevice}: ${device.device_id}`,
      `${t.developerStarted}: ${session.startedAt ?? '—'}`,
      `${t.developerFinished}: ${session.finishedAt ?? '—'}`,
      `${t.developerProgress}: ${counts.completed}/${counts.total} (${counts.passed} ${t.developerPass}, ${counts.failed} ${t.developerFail})`,
      '',
    ];
    for (const suite of suites) {
      lines.push(suite.title);
      suite.steps.forEach((step, index) => {
        lines.push(`- [${resultLabel(session.results[`${suite.id}:${index}`], t)}] ${step}`);
      });
      if (session.notes[suite.id]) lines.push(`${t.developerNotes}: ${session.notes[suite.id]}`);
      lines.push('');
    }
    lines.push(`${t.developerSnapshots}: ${session.snapshots.length}`);
    for (const snapshot of session.snapshots) lines.push(JSON.stringify(snapshot));
    return lines.join('\n');
  };

  const shareReport = async () => {
    setSharing(true);
    try {
      const text = buildReport();
      if (navigator.share) {
        await navigator.share({ title: `BikeBoss ${t.developerTitle}`, text });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        toast.success(t.developerReportCopied);
      } else {
        throw new Error('share_unavailable');
      }
    } catch (error) {
      if (error?.name !== 'AbortError') toast.error(t.developerShareFailed);
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="screen developer-screen">
      <section className="developer-hero">
        <div className="developer-hero-icon"><ToolsIcon /></div>
        <div>
          <span className="developer-badge">{t.developerStagingOnly}</span>
          <h1>{t.developerTitle}</h1>
          <p>{t.developerSubtitle}</p>
        </div>
      </section>

      <aside className="developer-safety" role="note">
        <AlertIcon />
        <div><strong>{t.developerSafetyTitle}</strong><p>{t.developerSafetyBody}</p></div>
      </aside>

      <section className="card developer-session-card">
        <div className="card-title">
          <h2><ClockIcon />{t.developerFieldSession}</h2>
          <span className={`developer-session-state ${session.active ? 'active' : ''}`}>
            {session.active ? t.developerRecording : t.developerNotRecording}
          </span>
        </div>
        <div className="developer-progress-row">
          <div className="developer-progress-copy">
            <strong>{counts.completed}/{counts.total}</strong>
            <span>{t.developerChecksCompleted}</span>
          </div>
          <div className="developer-progress-track">
            <span style={{ width: `${counts.total ? (counts.completed / counts.total) * 100 : 0}%` }} />
          </div>
          <div className="developer-result-counts">
            <span className="pass"><CheckCircleIcon />{counts.passed}</span>
            <span className="fail"><XIcon />{counts.failed}</span>
          </div>
        </div>
        <div className="developer-actions two">
          {!session.active ? (
            <button className="btn primary" type="button" onClick={startSession}>
              <RouteIcon />{t.developerStartSession}
            </button>
          ) : (
            <button className="btn danger" type="button" onClick={finishSession}>
              <CheckCircleIcon />{t.developerFinishSession}
            </button>
          )}
          <button className="btn ghost" type="button" onClick={shareReport} disabled={sharing}>
            <ExternalIcon />{sharing ? t.developerSharing : t.developerShareReport}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-title">
          <h2><GaugeIcon />{t.developerLiveDiagnostics}</h2>
          <button
            type="button"
            className="refresh-btn"
            aria-label={t.refresh}
            disabled={loading}
            onClick={() => { haptic.light(); loadLive(); onRefresh?.(); }}
          >
            <RefreshIcon className={loading ? 'spin' : ''} />
          </button>
        </div>
        <div className="developer-metric-grid">
          {metrics.map((metric) => (
            <article className={`developer-metric ${metric.tone}`} key={metric.id}>
              <span className="developer-metric-icon">{metric.icon}</span>
              <div><small>{metric.label}</small><strong>{metric.value}</strong><span>{metric.detail}</span></div>
            </article>
          ))}
        </div>
        <div className="developer-actions two">
          <button className="btn ghost" type="button" onClick={captureSnapshot}>
            <PinIcon />{t.developerCaptureSnapshot}
          </button>
          <button className="btn ghost" type="button" onClick={() => onNavigate?.('map')}>
            <ShieldIcon />{t.developerOpenMap}
          </button>
        </div>
        <p className="hint">{t.developerSnapshotsSaved(session.snapshots.length, MAX_SNAPSHOTS)}</p>
      </section>

      <section className="developer-suite-list" aria-label={t.developerGuidedTests}>
        <h2 className="developer-section-title"><ToolsIcon />{t.developerGuidedTests}</h2>
        {suites.map((suite, suiteIndex) => {
          const suiteResults = suite.steps.map((_, index) => session.results[`${suite.id}:${index}`]);
          const suiteDone = suiteResults.filter((value) => value === 'pass' || value === 'fail').length;
          return (
            <details className="developer-suite" key={suite.id} open={suiteIndex === 0}>
              <summary>
                <span className="developer-suite-number">{suiteIndex + 1}</span>
                <span><strong>{suite.title}</strong><small>{suiteDone}/{suite.steps.length} {t.developerComplete}</small></span>
                <span className="developer-suite-chevron">⌄</span>
              </summary>
              <div className="developer-suite-body">
                <p>{suite.description}</p>
                {suite.warning && (
                  <div className="developer-suite-warning"><AlertIcon />{suite.warning}</div>
                )}
                <ol className="developer-checklist">
                  {suite.steps.map((step, index) => {
                    const key = `${suite.id}:${index}`;
                    const result = session.results[key] ?? 'pending';
                    return (
                      <li className={result} key={key}>
                        <span className="developer-step-copy">{step}</span>
                        <span className="developer-step-actions">
                          <button
                            type="button"
                            className={result === 'pass' ? 'selected pass' : ''}
                            aria-label={`${t.developerPass}: ${step}`}
                            onClick={() => setResult(suite.id, index, 'pass')}
                          ><CheckCircleIcon /></button>
                          <button
                            type="button"
                            className={result === 'fail' ? 'selected fail' : ''}
                            aria-label={`${t.developerFail}: ${step}`}
                            onClick={() => setResult(suite.id, index, 'fail')}
                          ><XIcon /></button>
                        </span>
                      </li>
                    );
                  })}
                </ol>
                <label className="developer-notes">
                  <span>{t.developerNotes}</span>
                  <textarea
                    value={session.notes[suite.id] ?? ''}
                    onChange={(event) => setNote(suite.id, event.target.value)}
                    placeholder={t.developerNotesPlaceholder}
                    rows="3"
                  />
                </label>
              </div>
            </details>
          );
        })}
      </section>

      <aside className="developer-local-note">
        <InfoIcon />
        <p>{t.developerLocalStorageNote}</p>
      </aside>
    </div>
  );
}
