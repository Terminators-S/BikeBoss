import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, haptic } from '../api.js';
import { useLanguage } from '../components/LanguageProvider.jsx';
import { useToast } from '../components/Toast.jsx';
import Sheet from '../components/Sheet.jsx';
import { timeAgo, fmtDate } from '../format.js';
import {
  RouteIcon, BellIcon, AlertIcon, InfoIcon, CheckCircleIcon, ClockIcon,
} from '../components/icons.jsx';

function scoreClass(score) {
  if (score == null) return '';
  if (score >= 80) return 'good';
  if (score >= 50) return 'meh';
  return 'poor';
}

const SEV_ICON = { info: InfoIcon, warning: AlertIcon, critical: AlertIcon };

const MAP_TILE_URL = import.meta.env.VITE_MAP_TILE_URL
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MAP_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function formatDuration(seconds, t) {
  const totalMinutes = Math.max(0, Math.round(Number(seconds ?? 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} ${t.minuteShort}`;
  if (minutes === 0) return `${hours} ${t.hourShort}`;
  return `${hours} ${t.hourShort} ${minutes} ${t.minuteShort}`;
}

function TripRouteMap({ points }) {
  const container = useRef(null);

  useEffect(() => {
    if (!container.current || !points?.length) return undefined;
    const coordinates = points
      .map((point) => [Number(point.lat), Number(point.lon)])
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
    if (coordinates.length === 0) return undefined;

    const map = L.map(container.current, {
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: true,
    });
    L.tileLayer(MAP_TILE_URL, {
      attribution: MAP_ATTRIBUTION,
      maxZoom: 19,
      minZoom: 2,
      crossOrigin: true,
    }).addTo(map);

    let segment = [];
    let previous = null;
    for (const point of points) {
      const coordinate = [Number(point.lat), Number(point.lon)];
      if (!coordinate.every(Number.isFinite)) continue;
      if (point.gap_before && previous) {
        if (segment.length > 1) {
          L.polyline(segment, {
            color: '#7c3aed', weight: 4, opacity: 0.82,
            lineCap: 'round', lineJoin: 'round', interactive: false,
          }).addTo(map);
        }
        L.polyline([previous, coordinate], {
          color: '#94a3b8', weight: 3, opacity: 0.8, dashArray: '3 8',
          interactive: false,
        }).addTo(map);
        segment = [coordinate];
      } else {
        segment.push(coordinate);
      }
      previous = coordinate;
    }
    if (segment.length > 1) {
      L.polyline(segment, {
        color: '#7c3aed', weight: 4, opacity: 0.82,
        lineCap: 'round', lineJoin: 'round', interactive: false,
      }).addTo(map);
    }

    L.circleMarker(coordinates[0], {
      radius: 6, color: '#ffffff', weight: 2,
      fillColor: '#16a34a', fillOpacity: 1,
    }).addTo(map);
    L.circleMarker(coordinates.at(-1), {
      radius: 6, color: '#ffffff', weight: 2,
      fillColor: '#ef4444', fillOpacity: 1,
    }).addTo(map);
    if (coordinates.length === 1) map.setView(coordinates[0], 17);
    else map.fitBounds(L.latLngBounds(coordinates), { padding: [24, 24], maxZoom: 17 });
    const frame = window.requestAnimationFrame(() => map.invalidateSize());
    return () => {
      window.cancelAnimationFrame(frame);
      map.remove();
    };
  }, [points]);

  return <div ref={container} className="trip-route-map" />;
}

export default function ActivityScreen({ trips, events, onRefresh, canLoadTripDetail = true }) {
  const { t } = useLanguage();
  const toast = useToast();
  const [tab, setTab] = useState('trips');
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [tripDetail, setTripDetail] = useState(null);
  const [tripLoading, setTripLoading] = useState(false);
  const [tripFailed, setTripFailed] = useState(false);
  const [tripRetry, setTripRetry] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [acknowledging, setAcknowledging] = useState(false);

  const eventLabel = (type) => t[`event_${type}`] ?? type.replace(/_/g, ' ').toLowerCase();

  useEffect(() => {
    if (!selectedTrip?.id) {
      setTripDetail(null);
      setTripLoading(false);
      setTripFailed(false);
      return undefined;
    }
    if (!canLoadTripDetail) {
      setTripDetail({ trip: selectedTrip, route: { points: [] } });
      setTripLoading(false);
      setTripFailed(false);
      return undefined;
    }
    let cancelled = false;
    setTripDetail(null);
    setTripLoading(true);
    setTripFailed(false);
    api.tripDetail(selectedTrip.id)
      .then((result) => {
        if (!cancelled) setTripDetail(result);
      })
      .catch(() => {
        if (!cancelled) setTripFailed(true);
      })
      .finally(() => {
        if (!cancelled) setTripLoading(false);
      });
    return () => { cancelled = true; };
  }, [canLoadTripDetail, selectedTrip?.id, tripRetry]);

  const displayedTrip = tripDetail?.trip ?? selectedTrip;
  const displayedTripStatus = displayedTrip?.status
    ?? (displayedTrip?.end_time ? 'completed' : 'ongoing');

  const acknowledgeEvent = async () => {
    if (!selectedEvent?.id) return;
    setAcknowledging(true);
    try {
      const result = await api.acknowledgeGeofenceEvent(selectedEvent.id);
      setSelectedEvent({ ...selectedEvent, acknowledged_at: result.event.acknowledged_at });
      toast.success(t.eventAcknowledged);
      await onRefresh?.();
    } catch {
      toast.error(t.connectionError);
    } finally {
      setAcknowledging(false);
    }
  };

  return (
    <div className="screen">
      <div className="segmented">
        <button
          className={`seg-btn ${tab === 'trips' ? 'active' : ''}`}
          onClick={() => { setTab('trips'); haptic.select(); }}
        >
          {t.tripsTab}
        </button>
        <button
          className={`seg-btn ${tab === 'events' ? 'active' : ''}`}
          onClick={() => { setTab('events'); haptic.select(); }}
        >
          {t.eventsTab}
        </button>
      </div>

      {tab === 'trips' && (
        <section className="card">
          <h2><RouteIcon />{t.tripsTab}</h2>
          {trips.length === 0 && (
            <div className="empty-state">
              <RouteIcon />
              <p>{t.noTrips}</p>
            </div>
          )}
          <ul className="trip-list">
            {trips.map((trip) => (
              <li key={trip.id}>
                <button
                  className="trip"
                  onClick={() => { haptic.light(); setSelectedTrip(trip); }}
                >
                  <div className="trip-head">
                    <span>{fmtDate(trip.start_time)}</span>
                    <span className="trip-dist">{(trip.distance_km ?? 0).toFixed(1)} km</span>
                  </div>
                  <div className="trip-stats">
                    {trip.status === 'ongoing' && (
                      <span className="score-chip good">{t.tripOngoing}</span>
                    )}
                    <span className="score-chip">
                      {t.maxSpeed} {(trip.max_speed_kmh ?? 0).toFixed(0)} km/h
                    </span>
                    <span className="score-chip">
                      {t.averageSpeed} {(trip.avg_speed_kmh ?? 0).toFixed(0)} km/h
                    </span>
                    <span className={`score-chip ${scoreClass(trip.safety_score)}`}>
                      {t.safety} {trip.safety_score ?? '—'}
                    </span>
                    <span className={`score-chip ${scoreClass(trip.eco_score)}`}>
                      {t.eco} {trip.eco_score ?? '—'}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'events' && (
        <section className="card">
          <h2><BellIcon />{t.eventsTab}</h2>
          {events.length === 0 && (
            <div className="empty-state">
              <BellIcon />
              <p>{t.noEvents}</p>
            </div>
          )}
          <ul className="event-list">
            {events.map((e) => {
              const Icon = SEV_ICON[e.severity] || InfoIcon;
              return (
                <li key={`${e.source ?? 'event'}-${e.id}`}>
                  <button
                    className={`event ${e.severity}`}
                    onClick={() => { setSelectedEvent(e); haptic.light(); }}
                  >
                    <span className="event-dot"><Icon /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="event-type">{eventLabel(e.event_type)}</div>
                      <div className="label">{e.zone_name ? `${e.zone_name} · ` : ''}{timeAgo(e.created_at, t)}</div>
                    </div>
                    {e.acknowledged_at && <span className="event-ack"><CheckCircleIcon /></span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ---- Trip detail sheet ---- */}
      <Sheet open={!!selectedTrip} onClose={() => setSelectedTrip(null)} closeLabel={t.cancel}>
        {displayedTrip && (
          <>
            <div className="sheet-title">
              <RouteIcon />
              {t.tripDetail}
            </div>
            {tripLoading && (
              <div className="trip-route-state">
                <span className="spinner small" />
                <span>{t.loadingTrip}</span>
              </div>
            )}
            {tripFailed && (
              <div className="trip-route-state error">
                <span>{t.tripLoadFailed}</span>
                <button className="btn ghost primary" onClick={() => setTripRetry((value) => value + 1)}>
                  {t.retry}
                </button>
              </div>
            )}
            {tripDetail?.route?.points?.length > 0 && (
              <section className="trip-route-section">
                <h3>{t.tripRoute}</h3>
                <TripRouteMap points={tripDetail.route.points} />
              </section>
            )}
            <div className="row-list">
              <div className="row-item">
                <span className="row-label"><ClockIcon />{t.started}</span>
                <span className="row-value">{fmtDate(displayedTrip.start_time)}</span>
              </div>
              {displayedTrip.end_time && (
                <div className="row-item">
                  <span className="row-label"><ClockIcon />{t.ended}</span>
                  <span className="row-value">{fmtDate(displayedTrip.end_time)}</span>
                </div>
              )}
              <div className="row-item">
                <span className="row-label"><InfoIcon />{t.tripStatus}</span>
                <span className={`score-chip ${displayedTripStatus === 'ongoing' ? 'good' : ''}`}>
                  {displayedTripStatus === 'ongoing' ? t.tripOngoing : t.tripCompleted}
                </span>
              </div>
              <div className="row-item">
                <span className="row-label"><ClockIcon />{t.duration}</span>
                <span className="row-value">{formatDuration(displayedTrip.duration_seconds, t)}</span>
              </div>
              <div className="row-item">
                <span className="row-label"><RouteIcon />{t.distance}</span>
                <span className="row-value">{(displayedTrip.distance_km ?? 0).toFixed(2)} km</span>
              </div>
              <div className="row-item">
                <span className="row-label"><AlertIcon />{t.maxSpeed}</span>
                <span className="row-value">{(displayedTrip.max_speed_kmh ?? 0).toFixed(0)} km/h</span>
              </div>
              <div className="row-item">
                <span className="row-label"><InfoIcon />{t.averageSpeed}</span>
                <span className="row-value">{(displayedTrip.avg_speed_kmh ?? 0).toFixed(1)} km/h</span>
              </div>
              <div className="row-item">
                <span className="row-label"><CheckCircleIcon />{t.safety}</span>
                <span className={`score-chip ${scoreClass(displayedTrip.safety_score)}`}>
                  {displayedTrip.safety_score ?? '—'} / 100
                </span>
              </div>
              <div className="row-item">
                <span className="row-label"><CheckCircleIcon />{t.eco}</span>
                <span className={`score-chip ${scoreClass(displayedTrip.eco_score)}`}>
                  {displayedTrip.eco_score ?? '—'} / 100
                </span>
              </div>
            </div>
            <div className="sheet-actions">
              <button className="btn ghost primary" onClick={() => setSelectedTrip(null)}>
                {t.done}
              </button>
            </div>
          </>
        )}
      </Sheet>

      <Sheet open={!!selectedEvent} onClose={() => setSelectedEvent(null)} closeLabel={t.cancel}>
        {selectedEvent && (
          <>
            <div className={`event-detail-head ${selectedEvent.severity}`}>
              <span>{selectedEvent.severity === 'critical' || selectedEvent.severity === 'warning' ? <AlertIcon /> : <InfoIcon />}</span>
              <div><small>{t.eventDetails}</small><h2>{eventLabel(selectedEvent.event_type)}</h2></div>
            </div>
            <div className="row-list">
              <div className="row-item">
                <span className="row-label"><ClockIcon />{t.started}</span>
                <span className="row-value">{fmtDate(selectedEvent.created_at)}</span>
              </div>
              {selectedEvent.zone_name && (
                <div className="row-item">
                  <span className="row-label"><ShieldEventIcon />{t.eventZone}</span>
                  <span className="row-value">{selectedEvent.zone_name}</span>
                </div>
              )}
              {selectedEvent.distance_m != null && (
                <div className="row-item">
                  <span className="row-label"><RouteIcon />{t.eventDistance}</span>
                  <span className="row-value">{Number(selectedEvent.distance_m).toFixed(0)} m</span>
                </div>
              )}
              {selectedEvent.accuracy_m != null && (
                <div className="row-item">
                  <span className="row-label"><InfoIcon />{t.eventAccuracy}</span>
                  <span className="row-value">±{Number(selectedEvent.accuracy_m).toFixed(0)} m</span>
                </div>
              )}
            </div>
            {selectedEvent.gps_lat != null && selectedEvent.gps_lon != null && (
              <a
                className="btn ghost primary"
                href={`https://maps.google.com/?q=${selectedEvent.gps_lat},${selectedEvent.gps_lon}`}
                target="_blank"
                rel="noreferrer"
              >{t.openInMaps}</a>
            )}
            {selectedEvent.source === 'geofence_v2' && !selectedEvent.acknowledged_at ? (
              <button className="btn primary" onClick={acknowledgeEvent} disabled={acknowledging}>
                {acknowledging && <span className="spinner small" />}
                {t.acknowledge}
              </button>
            ) : selectedEvent.acknowledged_at ? (
              <div className="acknowledged-banner"><CheckCircleIcon />{t.acknowledged}</div>
            ) : null}
            <button className="btn ghost primary" onClick={() => setSelectedEvent(null)}>{t.done}</button>
          </>
        )}
      </Sheet>
    </div>
  );
}

function ShieldEventIcon() {
  return <CheckCircleIcon />;
}
