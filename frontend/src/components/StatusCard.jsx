import { useLanguage } from './LanguageProvider.jsx';

export default function StatusCard({ device, latest, onRefresh }) {
  const { t } = useLanguage();
  const armLabels = [t.disarmed, t.armed, t.pendingUnlock];
  const armClass = ['disarmed', 'armed', 'pending'][latest?.arm_state ?? 0];

  return (
    <section className="card">
      <div className="card-title">
        <h2>{device?.vehicle_model || t.myBike}</h2>
        <button className="btn small" onClick={onRefresh}>↻</button>
      </div>
      <div className={`arm-state ${armClass}`}>
        {armLabels[latest?.arm_state ?? 0]}
      </div>
      <div className="grid">
        <div className="stat">
          <span className="label">{t.battery}</span>
          <span className="value">{latest?.vbat != null ? `${latest.vbat.toFixed(1)}V` : '—'}</span>
        </div>
        <div className="stat">
          <span className="label">{t.speed}</span>
          <span className="value">{latest?.gps_speed != null ? `${latest.gps_speed.toFixed(0)} km/h` : '—'}</span>
        </div>
        <div className="stat">
          <span className="label">{t.gps}</span>
          <span className="value">{latest?.gps_fix ? t.gpsFixed : t.gpsNoFix}</span>
        </div>
        <div className="stat">
          <span className="label">{t.lastSeen}</span>
          <span className="value small">{latest?.received_at || t.never}</span>
        </div>
      </div>
      <p className="hint">{t.armHint}</p>
    </section>
  );
}
