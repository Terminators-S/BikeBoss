const SEVERITY_ICON = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };

export default function EventsList({ events }) {
  return (
    <section className="card">
      <h2>Recent Events</h2>
      {!events?.length && <p className="hint">No events yet.</p>}
      <ul className="event-list">
        {events?.map((e) => (
          <li key={e.id} className={`event ${e.severity}`}>
            <span className="icon">{SEVERITY_ICON[e.severity] || 'ℹ️'}</span>
            <div>
              <div className="event-type">{e.event_type}</div>
              <div className="label">{e.created_at}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
