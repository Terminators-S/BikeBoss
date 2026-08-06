import { useLanguage } from './LanguageProvider.jsx';

export default function LocationCard({ latest, geofences }) {
  const { t } = useLanguage();
  const hasFix = latest?.gps_fix && latest?.gps_lat != null;

  return (
    <section className="card">
      <h2>{t.location}</h2>
      {hasFix ? (
        <>
          <div className="coords">
            <span>{latest.gps_lat.toFixed(6)}</span>
            <span>{latest.gps_lon.toFixed(6)}</span>
          </div>
          <a
            className="btn"
            href={`https://maps.google.com/?q=${latest.gps_lat},${latest.gps_lon}`}
            target="_blank"
            rel="noreferrer"
          >
            {t.openInMaps}
          </a>
        </>
      ) : (
        <p className="hint">{t.noGpsFix}</p>
      )}

      {geofences?.length > 0 && (
        <div className="geofences">
          <h3>{t.activeGeofences}</h3>
          {geofences.map((z) => (
            <div key={z.id} className="geofence-row">
              <span>{z.label}</span>
              <span className="label">{z.radius_m}m</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
