import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLanguage } from './LanguageProvider.jsx';

export default function TripsList({ deviceId }) {
  const { t } = useLanguage();
  const [trips, setTrips] = useState(null);

  useEffect(() => {
    api.trips(deviceId).then(setTrips).catch(() => setTrips([]));
  }, [deviceId]);

  return (
    <section className="card">
      <h2>{t.recentTrips}</h2>
      {!trips && <p className="hint">{t.loading}</p>}
      {trips?.length === 0 && <p className="hint">{t.noTrips}</p>}
      <ul className="trip-list">
        {trips?.map((trip) => (
          <li key={trip.id} className="trip">
            <div className="trip-head">
              <span>{(trip.start_time || '').slice(0, 16)}</span>
              <span>{(trip.distance_km ?? 0).toFixed(1)} km</span>
            </div>
            <div className="trip-stats">
              <span>{t.maxSpeed} {(trip.max_speed_kmh ?? 0).toFixed(0)} km/h</span>
              <span>{t.safety} {trip.safety_score ?? '—'}/100</span>
              <span>{t.eco} {trip.eco_score ?? '—'}/100</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
