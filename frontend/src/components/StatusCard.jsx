export default function StatusCard({ device, latest, onRefresh }) {
  const armLabels = ['Disarmed', 'Armed', 'Pending Unlock'];
  const armClass = ['disarmed', 'armed', 'pending'][latest?.arm_state ?? 0];

  return (
    <section className="card">
      <div className="card-title">
        <h2>{device?.vehicle_model || 'My Bike'}</h2>
        <button className="btn small" onClick={onRefresh}>↻</button>
      </div>
      <div className={`arm-state ${armClass}`}>
        {armLabels[latest?.arm_state ?? 0]}
      </div>
      <div className="grid">
        <div className="stat">
          <span className="label">Battery</span>
          <span className="value">{latest?.vbat != null ? `${latest.vbat.toFixed(1)}V` : '—'}</span>
        </div>
        <div className="stat">
          <span className="label">Speed</span>
          <span className="value">{latest?.gps_speed != null ? `${latest.gps_speed.toFixed(0)} km/h` : '—'}</span>
        </div>
        <div className="stat">
          <span className="label">GPS</span>
          <span className="value">{latest?.gps_fix ? 'Fixed' : 'No fix'}</span>
        </div>
        <div className="stat">
          <span className="label">Last seen</span>
          <span className="value small">{latest?.received_at || 'never'}</span>
        </div>
      </div>
      <p className="hint">
        Remote arm/disarm lands on the next device heartbeat — use the bot commands
        /arm and /disarm to queue them.
      </p>
    </section>
  );
}
