import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function TripsList({ deviceId }) {
  const [trips, setTrips] = useState(null);

  useEffect(() => {
    api.trips(deviceId).then(setTrips).catch(() => setTrips([]));
  }, [deviceId]);

  return (
    <section className="card">
      <h2>Recent Trips</h2>
      {!trips && <p className="hint">Loading…</p>}
      {trips?.length === 0 && <p className="hint">No trips recorded yet.</p>}
      <ul className="trip-list">
        {trips?.map((t) => (
          <li key={t.id} className="trip">
            <div className="trip-head">
              <span>{(t.start_time || '').slice(0, 16)}</span>
              <span>{(t.distance_km ?? 0).toFixed(1)} km</span>
            </div>
            <div className="trip-stats">
              <span>Max {(t.max_speed_kmh ?? 0).toFixed(0)} km/h</span>
              <span>Safety {t.safety_score ?? '—'}/100</span>
              <span>Eco {t.eco_score ?? '—'}/100</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
