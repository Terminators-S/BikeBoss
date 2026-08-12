import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { api, haptic } from '../api.js';
import { useLanguage } from '../components/LanguageProvider.jsx';
import { useToast } from '../components/Toast.jsx';
import Sheet from '../components/Sheet.jsx';
import { timeAgo } from '../format.js';
import {
  AlertIcon, CheckCircleIcon, ClockIcon, EditIcon, LayersIcon,
  NavigationIcon, PinIcon, RefreshIcon, SatelliteIcon, ShieldIcon,
  SparklesIcon, TrashIcon, InfoIcon,
} from '../components/icons.jsx';

const MAP_TILE_URL = import.meta.env.VITE_MAP_TILE_URL
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MAP_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const SATELLITE_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SATELLITE_ATTRIBUTION = '&copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const MAP_LAYERS = {
  street: { url: MAP_TILE_URL, attribution: MAP_ATTRIBUTION },
  satellite: { url: SATELLITE_TILE_URL, attribution: SATELLITE_ATTRIBUTION },
};
const PHNOM_PENH = [104.9282, 11.5564];
const EARTH_RADIUS_M = 6371000;
const LIVE_POLL_MS = 4_000;
const STALE_AFTER_MS = 2 * 60 * 1000;
const OFFLINE_AFTER_MS = 45_000;
const HISTORY_RANGES = ['1h', '6h', '24h', '7d'];

function parseServerTime(value) {
  if (!value) return null;
  const normalized = /Z|[+-]\d\d:\d\d$/u.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hasLocation(latest) {
  return !!latest?.gps_fix
    && Number.isFinite(Number(latest.gps_lat))
    && Number.isFinite(Number(latest.gps_lon))
    && !(Number(latest.gps_lat) === 0 && Number(latest.gps_lon) === 0);
}

function locationFreshness(latest, connectivity) {
  if (connectivity?.online === false || connectivity?.status === 'offline') return 'offline';
  if (!hasLocation(latest)) return 'offline';
  const timestamp = parseServerTime(latest.captured_at ?? latest.received_at);
  if (!timestamp) return 'stale';
  const age = Date.now() - timestamp;
  if (age >= OFFLINE_AFTER_MS) return 'offline';
  if (age >= STALE_AFTER_MS) return 'stale';
  return 'live';
}

function gpsQuality(latest) {
  const accuracy = Number(latest?.gps_accuracy_m);
  if (!Number.isFinite(accuracy)) return 'fair';
  if (accuracy <= 15) return 'good';
  if (accuracy <= 35) return 'fair';
  return 'poor';
}

function circlePolygon(center, radiusM, steps = 72) {
  const [longitude, latitude] = center;
  const angularDistance = radiusM / EARTH_RADIUS_M;
  const latitudeRadians = latitude * Math.PI / 180;
  const longitudeRadians = longitude * Math.PI / 180;
  const coordinates = [];
  for (let step = 0; step <= steps; step += 1) {
    const bearing = (step / steps) * Math.PI * 2;
    const pointLatitude = Math.asin(
      Math.sin(latitudeRadians) * Math.cos(angularDistance)
      + Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const pointLongitude = longitudeRadians + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
      Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(pointLatitude),
    );
    coordinates.push([pointLongitude * 180 / Math.PI, pointLatitude * 180 / Math.PI]);
  }
  return coordinates;
}

function normalizeZone(zone) {
  if (zone?.geometry?.type === 'Circle') {
    return {
      ...zone,
      center: zone.geometry.center.map(Number),
      radiusM: Number(zone.geometry.radius_m),
      version: Number(zone.version),
      stateValue: zone.state?.value ?? 'UNKNOWN',
    };
  }
  return {
    ...zone,
    id: zone.zone_uuid ?? `legacy-${zone.id}`,
    name: zone.label,
    center: [Number(zone.anchor_lon), Number(zone.anchor_lat)],
    radiusM: Number(zone.radius_m),
    status: zone.is_active ? 'active' : 'paused',
    version: Number(zone.version ?? 1),
    stateValue: 'UNKNOWN',
  };
}

function zoneColor(zone) {
  if (zone.status !== 'active') return '#64748b';
  if (zone.stateValue === 'OUTSIDE' || zone.stateValue === 'EXIT_CANDIDATE') return '#ef4444';
  if (zone.stateValue === 'INSIDE') return '#16a34a';
  return '#2563eb';
}

function trailLatLngs(trail) {
  return (trail ?? [])
    .map((point) => [Number(point.lat), Number(point.lon)])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
}

function trailSegments(trail) {
  const segments = [];
  const gaps = [];
  let segment = [];
  let previous = null;
  for (const point of trail ?? []) {
    const lat = Number(point.lat);
    const lon = Number(point.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const latLng = [lat, lon];
    if (point.gap_before && previous) {
      if (segment.length > 1) segments.push(segment);
      gaps.push([previous, latLng]);
      segment = [latLng];
    } else {
      segment.push(latLng);
    }
    previous = latLng;
  }
  if (segment.length > 1) segments.push(segment);
  return { segments, gaps };
}

function distanceBetween(start, end) {
  const lat1 = start[0] * Math.PI / 180;
  const lat2 = end[0] * Math.PI / 180;
  const deltaLat = lat2 - lat1;
  const deltaLon = (end[1] - start[1]) * Math.PI / 180;
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function bearingBetween(start, end) {
  const lat1 = start[0] * Math.PI / 180;
  const lat2 = end[0] * Math.PI / 180;
  const deltaLon = (end[1] - start[1]) * Math.PI / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function routeDirectionMarkers(segments, maximumMarkers = 64) {
  const edges = [];
  let totalDistanceM = 0;
  for (const segment of segments) {
    for (let index = 1; index < segment.length; index += 1) {
      const start = segment[index - 1];
      const end = segment[index];
      const distanceM = distanceBetween(start, end);
      if (!Number.isFinite(distanceM) || distanceM < 1) continue;
      edges.push({ start, end, distanceM, offsetM: totalDistanceM });
      totalDistanceM += distanceM;
    }
  }
  if (totalDistanceM < 5 || edges.length === 0) return [];

  const markerCount = Math.min(maximumMarkers, Math.max(1, Math.ceil(totalDistanceM / 250)));
  const spacingM = totalDistanceM / (markerCount + 1);
  const markers = [];
  let edgeIndex = 0;
  for (let markerIndex = 1; markerIndex <= markerCount; markerIndex += 1) {
    const targetM = spacingM * markerIndex;
    while (edgeIndex < edges.length - 1
      && edges[edgeIndex].offsetM + edges[edgeIndex].distanceM < targetM) {
      edgeIndex += 1;
    }
    const edge = edges[edgeIndex];
    const ratio = Math.max(0, Math.min(1, (targetM - edge.offsetM) / edge.distanceM));
    markers.push({
      position: [
        edge.start[0] + (edge.end[0] - edge.start[0]) * ratio,
        edge.start[1] + (edge.end[1] - edge.start[1]) * ratio,
      ],
      bearing: bearingBetween(edge.start, edge.end),
    });
  }
  return markers;
}

function pointLatLng(point) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}

function playbackBearing(points, index) {
  const point = points[index];
  const reportedHeading = point?.heading == null ? NaN : Number(point.heading);
  if (Number.isFinite(reportedHeading)) return (reportedHeading + 360) % 360;

  const current = pointLatLng(point);
  if (!current) return 0;
  const previous = pointLatLng(points[index - 1]);
  if (previous && !point.gap_before) return bearingBetween(previous, current);
  const next = pointLatLng(points[index + 1]);
  if (next && !points[index + 1]?.gap_before) return bearingBetween(current, next);
  return 0;
}

function directionIcon(bearing, current = false) {
  const arrow = document.createElement('span');
  arrow.className = current ? 'playback-direction-arrow' : 'route-direction-arrow';
  arrow.style.setProperty('--route-bearing', `${bearing}deg`);
  const size = current ? 30 : 18;
  return L.divIcon({
    className: 'bikeboss-direction-icon',
    html: arrow,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function trailPointAsTelemetry(point) {
  if (!point) return null;
  return {
    ...point,
    gps_fix: 1,
    gps_lat: point.lat,
    gps_lon: point.lon,
    gps_accuracy_m: point.accuracy_m,
    gps_speed: point.speed_kmh,
  };
}

function distanceLabel(distanceM) {
  const value = Number(distanceM);
  if (!Number.isFinite(value)) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

export default function MapScreen({ device, latest: initialLatest, zones: initialZones, canEdit, onRefresh }) {
  const { t } = useLanguage();
  const toast = useToast();
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const tileLayerRef = useRef(null);
  const tileFailureTimerRef = useRef(null);
  const layerGroupsRef = useRef(null);
  const editorRef = useRef(null);
  const mapModeRef = useRef('live');
  const liveRequestRef = useRef(null);
  const historyRequestRef = useRef(null);
  const offlineTrailRequestRef = useRef(null);
  const historyCacheRef = useRef(new Map());
  const offlineTrailFitRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState({
    latest_telemetry: initialLatest,
    zones: initialZones ?? [],
    trail: [],
  });
  const [editor, setEditor] = useState(null);
  const [selectedZone, setSelectedZone] = useState(null);
  const [deleteZone, setDeleteZone] = useState(null);
  const [saving, setSaving] = useState(false);
  const [zoneBusy, setZoneBusy] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [suggestionBusy, setSuggestionBusy] = useState(null);
  const [mapMode, setMapMode] = useState('live');
  const [historyRange, setHistoryRange] = useState('1h');
  const [history, setHistory] = useState(null);
  const [offlineTrail, setOfflineTrail] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [autoFollow, setAutoFollow] = useState(true);
  const [mapLayer, setMapLayer] = useState('street');
  const [showCrashAlerts, setShowCrashAlerts] = useState(true);

  const latest = live.latest_telemetry ?? initialLatest;
  const normalizedZones = useMemo(
    () => (live.zones ?? initialZones ?? []).map(normalizeZone)
      .filter((zone) => Number.isFinite(zone.center[0]) && Number.isFinite(zone.center[1])),
    [live.zones, initialZones],
  );
  const historyPoints = useMemo(() => history?.points ?? [], [history?.points]);
  const playbackPoint = historyPoints[Math.min(playbackIndex, Math.max(0, historyPoints.length - 1))] ?? null;
  const displayLatest = mapMode === 'history' ? trailPointAsTelemetry(playbackPoint) : latest;
  const liveTrail = live.trail ?? [];
  const latestHasLocation = hasLocation(latest);
  const displayTrail = mapMode === 'history'
    ? historyPoints
    : liveTrail.length
      ? liveTrail
      : offlineTrail;
  const displayTrailLatLngs = useMemo(() => trailLatLngs(displayTrail), [displayTrail]);
  const lastTrailLatLng = displayTrailLatLngs[displayTrailLatLngs.length - 1] ?? null;
  const liveBikeCenter = hasLocation(latest)
    ? [Number(latest.gps_lon), Number(latest.gps_lat)]
    : lastTrailLatLng
      ? [lastTrailLatLng[1], lastTrailLatLng[0]]
      : PHNOM_PENH;
  const bikeCenter = hasLocation(displayLatest)
    ? [Number(displayLatest.gps_lon), Number(displayLatest.gps_lat)]
    : lastTrailLatLng
      ? [lastTrailLatLng[1], lastTrailLatLng[0]]
      : PHNOM_PENH;
  const connectivity = live.connectivity ?? device?.connectivity ?? {};
  const freshness = locationFreshness(latest, connectivity);
  const quality = gpsQuality(displayLatest);
  const sharedPrototype = device?.connection_mode === 'shared_prototype';

  useEffect(() => { editorRef.current = editor; }, [editor]);
  useEffect(() => { mapModeRef.current = mapMode; }, [mapMode]);

  const loadLive = useCallback(async ({ quiet = false } = {}) => {
    if (!canEdit) return;
    if (!quiet) setRefreshing(true);
    try {
      if (!liveRequestRef.current) {
        const request = api.liveDevice(device.device_id).then((result) => {
          setLive(result);
          return result;
        });
        liveRequestRef.current = request;
        const clearRequest = () => {
          if (liveRequestRef.current === request) liveRequestRef.current = null;
        };
        request.then(clearRequest, clearRequest);
      }
      await liveRequestRef.current;
    } catch (error) {
      if (!quiet) toast.error(t.connectionError);
    } finally {
      if (!quiet) setRefreshing(false);
    }
  }, [canEdit, device.device_id, t, toast]);

  const loadHistory = useCallback(async ({ force = false } = {}) => {
    if (!canEdit) return;
    const cached = historyCacheRef.current.get(historyRange);
    if (!force && cached && Date.now() - cached.savedAt < 60_000) {
      setHistory(cached.data);
      setPlaybackIndex(Math.max(0, (cached.data.points?.length ?? 1) - 1));
      setHistoryFailed(false);
      return;
    }
    if (historyRequestRef.current) return historyRequestRef.current;
    setHistoryLoading(true);
    setHistoryFailed(false);
    const request = api.deviceTrail(device.device_id, historyRange)
      .then((result) => {
        historyCacheRef.current.set(historyRange, { data: result, savedAt: Date.now() });
        setHistory(result);
        setPlaybackIndex(Math.max(0, (result.points?.length ?? 1) - 1));
        return result;
      })
      .catch((error) => {
        setHistoryFailed(true);
        throw error;
      })
      .finally(() => {
        if (historyRequestRef.current === request) historyRequestRef.current = null;
        setHistoryLoading(false);
      });
    historyRequestRef.current = request;
    return request;
  }, [canEdit, device.device_id, historyRange]);

  useEffect(() => {
    if (mapMode !== 'history') return;
    loadHistory().catch(() => {});
  }, [loadHistory, mapMode]);

  useEffect(() => {
    if (!canEdit || mapMode !== 'live' || latestHasLocation || liveTrail.length) return;
    if (offlineTrailRequestRef.current) return;
    const request = api.deviceTrail(device.device_id, '24h')
      .then((result) => {
        setOfflineTrail(result.points ?? []);
        return result;
      })
      .catch(() => null)
      .finally(() => {
        if (offlineTrailRequestRef.current === request) offlineTrailRequestRef.current = null;
      });
    offlineTrailRequestRef.current = request;
  }, [canEdit, device.device_id, latestHasLocation, liveTrail.length, mapMode]);

  const loadSuggestions = useCallback(async () => {
    if (!canEdit) return;
    try {
      setSuggestions(await api.placeSuggestions(device.device_id));
    } catch {
      setSuggestions({ suggestions: [], progress: { eligible_samples: 0, distinct_days: 0 } });
    }
  }, [canEdit, device.device_id]);

  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions]);

  useEffect(() => {
    if (mapMode !== 'live') return undefined;
    let timer = null;
    let running = false;
    let disposed = false;

    const poll = async () => {
      if (disposed || running || document.visibilityState !== 'visible') return;
      running = true;
      clearTimeout(timer);
      try {
        await loadLive({ quiet: true });
      } finally {
        running = false;
        if (!disposed) timer = setTimeout(poll, LIVE_POLL_MS);
      }
    };
    const refreshVisible = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      poll();
    };

    poll();
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refreshVisible);
    };
  }, [loadLive, mapMode]);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return undefined;
    let tileLoaded = false;
    let tileErrors = 0;
    const map = L.map(mapContainer.current, {
      zoomControl: false,
      scrollWheelZoom: false,
      doubleClickZoom: true,
      dragging: true,
      touchZoom: true,
      keyboard: true,
      attributionControl: true,
    }).setView([bikeCenter[1], bikeCenter[0]], hasLocation(displayLatest) ? 17 : 11);
    const tiles = L.tileLayer(MAP_TILE_URL, {
      attribution: MAP_ATTRIBUTION,
      maxZoom: 19,
      minZoom: 2,
      crossOrigin: true,
    }).addTo(map);
    tileLayerRef.current = { key: 'street', layer: tiles };
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.scale({ position: 'bottomleft', metric: true, imperial: false, maxWidth: 100 }).addTo(map);

    layerGroupsRef.current = {
      accuracy: L.layerGroup().addTo(map),
      trail: L.layerGroup().addTo(map),
      events: L.layerGroup().addTo(map),
      zones: L.layerGroup().addTo(map),
      bike: L.layerGroup().addTo(map),
    };

    const failTimer = setTimeout(() => {
      if (!tileLoaded) setMapFailed(true);
    }, 12_000);
    tileFailureTimerRef.current = failTimer;

    tiles.on('tileload', () => {
      tileLoaded = true;
      clearTimeout(failTimer);
      if (tileFailureTimerRef.current === failTimer) tileFailureTimerRef.current = null;
      setMapFailed(false);
    });
    tiles.on('tileerror', () => {
      tileErrors += 1;
      if (!tileLoaded && tileErrors >= 4) setMapFailed(true);
    });
    map.on('moveend', () => {
      if (!editorRef.current) return;
      const center = map.getCenter();
      setEditor((current) => current ? { ...current, center: [center.lng, center.lat] } : current);
    });
    map.on('dragstart', () => {
      if (!editorRef.current && mapModeRef.current === 'live') setAutoFollow(false);
    });
    map.whenReady(() => {
      setMapReady(true);
      window.requestAnimationFrame(() => map.invalidateSize());
    });
    mapRef.current = map;
    return () => {
      clearTimeout(failTimer);
      if (tileFailureTimerRef.current === failTimer) tileFailureTimerRef.current = null;
      setMapReady(false);
      map.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      layerGroupsRef.current = null;
    };
    // Live data is synchronized by the source-update effect below. Recreate the
    // map only when the user explicitly retries initialization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapAttempt]);

  useEffect(() => {
    const map = mapRef.current;
    const current = tileLayerRef.current;
    if (!mapReady || !map || current?.key === mapLayer) return;

    const config = MAP_LAYERS[mapLayer];
    let tileErrors = 0;
    clearTimeout(tileFailureTimerRef.current);
    const nextLayer = L.tileLayer(config.url, {
      attribution: config.attribution,
      maxZoom: 19,
      minZoom: 2,
      crossOrigin: true,
    });
    const failTimer = setTimeout(() => {
      if (tileLayerRef.current?.layer === nextLayer) setMapFailed(true);
    }, 12_000);
    tileFailureTimerRef.current = failTimer;
    nextLayer.on('tileload', () => {
      if (tileLayerRef.current?.layer !== nextLayer) return;
      clearTimeout(failTimer);
      if (tileFailureTimerRef.current === failTimer) tileFailureTimerRef.current = null;
      setMapFailed(false);
    });
    nextLayer.on('tileerror', () => {
      if (tileLayerRef.current?.layer !== nextLayer) return;
      tileErrors += 1;
      if (tileErrors >= 4) setMapFailed(true);
    });

    current?.layer.removeFrom(map);
    nextLayer.addTo(map);
    tileLayerRef.current = { key: mapLayer, layer: nextLayer };
  }, [mapLayer, mapReady]);

  useEffect(() => {
    const groups = layerGroupsRef.current;
    if (!mapReady || !groups) return;
    groups.trail.clearLayers();
    groups.events.clearLayers();

    const { segments, gaps } = trailSegments(displayTrail);
    segments.forEach((segment) => {
      L.polyline(segment, {
        color: mapMode === 'history' ? '#7c3aed' : '#2563eb', weight: 4, opacity: 0.76,
        lineCap: 'round', lineJoin: 'round', interactive: false,
      }).addTo(groups.trail);
    });
    gaps.forEach((gap) => {
      L.polyline(gap, {
        color: '#94a3b8', weight: 3, opacity: 0.8, dashArray: '3 8',
        lineCap: 'round', interactive: false,
      }).addTo(groups.trail);
    });

    if (mapMode === 'history') {
      routeDirectionMarkers(segments).forEach(({ position, bearing }) => {
        L.marker(position, {
          icon: directionIcon(bearing),
          interactive: false,
          keyboard: false,
          zIndexOffset: 300,
        }).addTo(groups.trail);
      });
    }

    if (mapMode === 'history') {
      (history?.events ?? []).forEach((event) => {
        if (!showCrashAlerts && String(event.event_type).toUpperCase() === 'CRASH') return;
        const lat = Number(event.gps_lat);
        const lon = Number(event.gps_lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const critical = event.severity === 'critical' || event.severity === 'warning';
        L.circleMarker([lat, lon], {
          radius: 6, color: '#ffffff', weight: 2,
          fillColor: critical ? '#ef4444' : '#f59e0b', fillOpacity: 1,
        }).addTo(groups.events);
      });
    }
  }, [displayTrail, history?.events, mapMode, mapReady, showCrashAlerts]);

  useEffect(() => {
    const groups = layerGroupsRef.current;
    if (!mapReady || !groups) return;
    groups.accuracy.clearLayers();
    groups.bike.clearLayers();

    if (hasLocation(displayLatest)) {
      const point = [Number(displayLatest.gps_lat), Number(displayLatest.gps_lon)];
      L.circle(point, {
        radius: Math.max(3, Number(displayLatest.gps_accuracy_m ?? 15)),
        color: '#2563eb', weight: 1, opacity: 0.45,
        fillColor: '#2563eb', fillOpacity: 0.11,
        interactive: false,
      }).addTo(groups.accuracy);
      L.circleMarker(point, {
        radius: 16, stroke: false, fillColor: '#2563eb', fillOpacity: 0.18,
        interactive: false,
      }).addTo(groups.bike);
      if (mapMode === 'history') {
        L.marker(point, {
          icon: directionIcon(playbackBearing(historyPoints, playbackIndex), true),
          interactive: false,
          keyboard: false,
          zIndexOffset: 1000,
        }).addTo(groups.bike);
      } else {
        L.circleMarker(point, {
          radius: 8, color: '#ffffff', weight: 3,
          fillColor: '#2563eb', fillOpacity: 1,
          interactive: false,
        }).addTo(groups.bike);
      }
    }
  }, [displayLatest, historyPoints, mapMode, mapReady, playbackIndex]);

  useEffect(() => {
    const groups = layerGroupsRef.current;
    if (!mapReady || !groups) return;
    groups.zones.clearLayers();
    normalizedZones.forEach((zone) => {
      const color = zoneColor(zone);
      const circle = L.circle([zone.center[1], zone.center[0]], {
        radius: zone.radiusM,
        color, weight: 3, opacity: 0.95, dashArray: '6 4',
        fillColor: color, fillOpacity: 0.16,
        className: 'bikeboss-zone-layer',
      }).addTo(groups.zones);
      circle.on('click', () => {
        if (editorRef.current) return;
        setSelectedZone(zone);
        haptic.light();
      });
    });
    if (editor?.center) {
      L.circle([editor.center[1], editor.center[0]], {
        radius: editor.radiusM,
        color: '#f59e0b', weight: 3, opacity: 1, dashArray: '7 5',
        fillColor: '#f59e0b', fillOpacity: 0.17,
        interactive: false,
      }).addTo(groups.zones);
    }
  }, [editor, mapReady, normalizedZones]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || mapMode !== 'live' || !autoFollow || !hasLocation(latest)) return;
    map.panTo([Number(latest.gps_lat), Number(latest.gps_lon)], { animate: true, duration: 0.45 });
  }, [autoFollow, latest, mapMode, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || mapMode !== 'history' || historyPoints.length < 2) return;
    const bounds = L.latLngBounds(trailLatLngs(historyPoints));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [38, 38], maxZoom: 17, animate: true });
  }, [history?.window?.from, historyPoints, mapMode, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || mapMode !== 'live' || hasLocation(latest) || !displayTrailLatLngs.length) return;
    const first = displayTrailLatLngs[0];
    const last = displayTrailLatLngs[displayTrailLatLngs.length - 1];
    const fitKey = `${displayTrailLatLngs.length}:${first.join(',')}:${last.join(',')}`;
    if (offlineTrailFitRef.current === fitKey) return;
    offlineTrailFitRef.current = fitKey;
    if (displayTrailLatLngs.length === 1) {
      map.setView(last, 16, { animate: true });
      return;
    }
    const bounds = L.latLngBounds(displayTrailLatLngs);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [38, 38], maxZoom: 17, animate: true });
  }, [displayTrailLatLngs, latest, mapMode, mapReady]);

  const focusBike = () => {
    if (!hasLocation(displayLatest)) return;
    haptic.light();
    if (mapMode === 'live') setAutoFollow(true);
    mapRef.current?.flyTo([bikeCenter[1], bikeCenter[0]], 17, { duration: 0.7 });
  };

  const fitZones = () => {
    const points = normalizedZones.flatMap((zone) => circlePolygon(zone.center, zone.radiusM, 16));
    if (hasLocation(displayLatest)) points.push(bikeCenter);
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map(([lon, lat]) => [lat, lon]));
    mapRef.current?.fitBounds(bounds, { padding: [52, 52], maxZoom: 17, animate: true, duration: 0.7 });
    haptic.light();
  };

  const retryMap = () => {
    setMapFailed(false);
    setMapReady(false);
    setMapAttempt((attempt) => attempt + 1);
  };

  const startEditor = (zone = null) => {
    if (!canEdit || (!zone && !hasLocation(latest))) {
      toast.error(t.geofenceFailed);
      return;
    }
    const center = zone?.center ?? liveBikeCenter;
    setMapMode('live');
    setSelectedZone(null);
    setEditor({
      mode: zone ? 'edit' : 'create',
      id: zone?.id ?? null,
      version: zone?.version ?? null,
      status: zone?.status ?? 'active',
      name: zone?.name ?? t.currentLocationZone,
      center,
      radiusM: zone?.radiusM ?? 100,
    });
    mapRef.current?.flyTo([center[1], center[0]], 17, { duration: 0.7 });
    haptic.medium();
  };

  const saveZone = async () => {
    if (!editor) return;
    setSaving(true);
    const payload = {
      name: editor.name.trim() || t.currentLocationZone,
      policy: 'safe',
      status: editor.status,
      geometry: { type: 'Circle', center: editor.center, radius_m: editor.radiusM },
    };
    try {
      if (editor.mode === 'edit') {
        await api.updateZone(editor.id, { ...payload, version: editor.version });
        toast.success(t.zoneUpdated);
      } else {
        await api.createZone(device.device_id, payload);
        toast.success(t.zoneSaved);
      }
      setEditor(null);
      await Promise.all([loadLive(), loadSuggestions(), onRefresh()]);
    } catch (error) {
      if (error.code === 'zone_version_conflict') toast.error(t.zoneChanged);
      else if (error.code === 'zone_radius_out_of_range') toast.error(t.zoneRadiusInvalid);
      else toast.error(t.connectionError);
    } finally {
      setSaving(false);
    }
  };

  const setZoneStatus = async (zone, status) => {
    setZoneBusy(zone.id);
    try {
      await api.updateZone(zone.id, { version: zone.version, status });
      toast.success(status === 'active' ? t.zoneActivated : t.zonePaused);
      setSelectedZone(null);
      await Promise.all([loadLive(), onRefresh()]);
    } catch (error) {
      toast.error(error.code === 'zone_version_conflict' ? t.zoneChanged : t.connectionError);
    } finally {
      setZoneBusy(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteZone) return;
    setZoneBusy(deleteZone.id);
    try {
      await api.archiveZone(deleteZone.id, deleteZone.version);
      toast.success(t.zoneDeleted);
      setDeleteZone(null);
      setSelectedZone(null);
      await Promise.all([loadLive(), loadSuggestions(), onRefresh()]);
    } catch (error) {
      toast.error(error.code === 'zone_version_conflict' ? t.zoneChanged : t.connectionError);
    } finally {
      setZoneBusy(null);
    }
  };

  const acceptSuggestion = async (suggestion) => {
    setSuggestionBusy(suggestion.id);
    try {
      await api.acceptPlaceSuggestion(suggestion.id, {
        name: suggestion.name,
        radius_m: suggestion.radius_m,
      });
      toast.success(t.suggestionAccepted);
      await Promise.all([loadSuggestions(), loadLive(), onRefresh()]);
    } catch {
      toast.error(t.connectionError);
    } finally {
      setSuggestionBusy(null);
    }
  };

  const dismissSuggestion = async (suggestion) => {
    setSuggestionBusy(suggestion.id);
    try {
      await api.dismissPlaceSuggestion(suggestion.id);
      toast.info(t.suggestionDismissed);
      await loadSuggestions();
    } catch {
      toast.error(t.connectionError);
    } finally {
      setSuggestionBusy(null);
    }
  };

  const statusText = freshness === 'live'
    ? t.liveLocation : freshness === 'stale' ? t.staleLocation : t.offlineLocation;
  const qualityText = freshness !== 'live'
    ? t.gpsUnavailable
    : quality === 'good'
      ? t.gpsQualityGood : quality === 'fair' ? t.gpsQualityFair : t.gpsQualityPoor;
  const transportText = connectivity.transport === 'wifi'
    ? t.uplinkWifi
    : connectivity.transport === 'cellular'
      ? t.uplinkCellular(connectivity.generation ?? '4g')
      : t.uplinkUnknown;
  const selectMapMode = (nextMode) => {
    if (nextMode === mapMode || (nextMode === 'history' && !canEdit)) return;
    haptic.select();
    setEditor(null);
    setMapMode(nextMode);
    if (nextMode === 'live') {
      setAutoFollow(true);
      loadLive({ quiet: true });
    }
  };
  const handlePlaybackChange = (event) => {
    const nextIndex = Math.max(0, Math.min(
      Number(event.target.value),
      Math.max(0, historyPoints.length - 1),
    ));
    setPlaybackIndex(nextIndex);
    const point = pointLatLng(historyPoints[nextIndex]);
    const map = mapRef.current;
    if (point && map) {
      map.setView(point, Math.max(map.getZoom(), 17), { animate: false });
    }
  };
  const presetNames = [t.zoneNameHome, t.zoneNameWork, t.zoneNameSchool, t.zoneNameParking];

  return (
    <div className="screen map-screen">
      {sharedPrototype && (
        <aside className="prototype-notice compact" role="status">
          <InfoIcon />
          <div>
            <strong>{t.sharedPrototypeTitle}</strong>
            <p>{t.sharedPrototypeMapNote}</p>
          </div>
        </aside>
      )}
      <section className="map-mode-panel" aria-label={t.trackingMode}>
        <div className="map-mode-row">
          <div className="segmented map-mode-switch">
            <button className={`seg-btn ${mapMode === 'live' ? 'active' : ''}`} onClick={() => selectMapMode('live')}>
              {t.liveMode}
            </button>
            <button className={`seg-btn ${mapMode === 'history' ? 'active' : ''}`} onClick={() => selectMapMode('history')} disabled={!canEdit}>
              {t.historyMode}
            </button>
          </div>
          {mapMode === 'history' && (
            <div className="history-ranges" aria-label={t.historyRange}>
              {HISTORY_RANGES.map((range) => (
                <button
                  key={range}
                  className={historyRange === range ? 'active' : ''}
                  disabled={historyLoading}
                  onClick={() => { setHistoryRange(range); haptic.select(); }}
                >{range}</button>
              ))}
            </div>
          )}
        </div>
        <div className="map-display-controls">
          <div className="segmented map-layer-switch" aria-label={t.mapStyle}>
            <button
              className={`seg-btn ${mapLayer === 'street' ? 'active' : ''}`}
              onClick={() => { setMapLayer('street'); haptic.select(); }}
              aria-pressed={mapLayer === 'street'}
            >
              <LayersIcon />
              <span>{t.streetMap}</span>
            </button>
            <button
              className={`seg-btn ${mapLayer === 'satellite' ? 'active' : ''}`}
              onClick={() => { setMapLayer('satellite'); haptic.select(); }}
              aria-pressed={mapLayer === 'satellite'}
            >
              <SatelliteIcon />
              <span>{t.satelliteMap}</span>
            </button>
          </div>
          {mapMode === 'history' && (
            <label className="crash-alert-toggle">
              <input
                type="checkbox"
                checked={showCrashAlerts}
                onChange={(event) => { setShowCrashAlerts(event.target.checked); haptic.select(); }}
                aria-label={showCrashAlerts ? t.hideCrashAlerts : t.showCrashAlerts}
              />
              <span className="toggle-track" aria-hidden="true"><span /></span>
              <AlertIcon />
              <span>{t.crashAlerts}</span>
            </label>
          )}
        </div>
      </section>
      <section className={`map-workspace ${editor ? 'editing' : ''}`}>
        <div ref={mapContainer} className="live-map" aria-label={t.liveMap} />

        {!mapReady && !mapFailed && (
          <div className="map-state-overlay">
            <span className="spinner" />
            <strong>{t.mapLoading}</strong>
          </div>
        )}
        {mapFailed && (
          <div className="map-state-overlay error">
            <AlertIcon />
            <strong>{t.mapLoadFailed}</strong>
            <button className="btn small" onClick={retryMap}>{t.retry}</button>
          </div>
        )}
        {!hasLocation(displayLatest) && mapReady && !historyLoading && (
          <div className="map-state-overlay compact">
            <SatelliteIcon />
            <strong>{displayTrailLatLngs.length ? t.noGpsFixShowingHistory : t.noGpsFix}</strong>
          </div>
        )}

        {mapMode === 'history' && historyLoading && (
          <div className="map-history-state"><span className="spinner small" />{t.loadingHistory}</div>
        )}
        {mapMode === 'history' && historyFailed && !historyLoading && (
          <div className="map-history-state error">
            <AlertIcon />{t.historyLoadFailed}
            <button onClick={() => loadHistory({ force: true }).catch(() => {})}>{t.retry}</button>
          </div>
        )}

        <div className={`map-live-card ${mapMode === 'history' ? 'history' : freshness}`}>
          <span className="map-live-dot" />
          <div>
            <strong>{mapMode === 'history' ? t.historyPlayback : statusText}</strong>
            <span>
              {mapMode === 'history'
                ? timeAgo(displayLatest?.captured_at ?? displayLatest?.received_at, t)
                : `${timeAgo(latest?.captured_at ?? latest?.received_at, t)} · ${qualityText} · ${transportText}`}
            </span>
          </div>
          {hasLocation(displayLatest) && (mapMode === 'history' || freshness === 'live')
            && <b>±{Math.round(Number(displayLatest.gps_accuracy_m ?? 15))}m</b>}
        </div>

        <div className="map-fab-stack">
          <button className="map-fab" onClick={focusBike} disabled={!hasLocation(displayLatest)} aria-label={t.centerBike}>
            <NavigationIcon />
          </button>
          <button className="map-fab" onClick={fitZones} disabled={!normalizedZones.length} aria-label={t.fitZones}>
            <LayersIcon />
          </button>
          <button
            className={`map-fab ${(refreshing || historyLoading) ? 'spinning' : ''}`}
            onClick={() => mapMode === 'history'
              ? loadHistory({ force: true }).catch(() => {})
              : loadLive()}
            aria-label={t.refresh}
          >
            <RefreshIcon />
          </button>
        </div>

        {mapMode === 'live' && !autoFollow && hasLocation(latest) && (
          <button className="return-live-btn" onClick={focusBike}><NavigationIcon />{t.returnToLive}</button>
        )}

        {editor && <div className="map-crosshair" aria-hidden="true"><PinIcon /></div>}

        {editor && (
          <div className="map-editor-panel">
            <div className="map-editor-head">
              <div>
                <span>{editor.mode === 'edit' ? t.editSafeZone : t.createSafeZone}</span>
                <small>{t.tapMapCenter}</small>
              </div>
              <button className="text-action" onClick={() => setEditor(null)} disabled={saving}>{t.cancel}</button>
            </div>
            <div className="zone-name-presets">
              {presetNames.map((name) => (
                <button
                  key={name}
                  className={editor.name === name ? 'active' : ''}
                  onClick={() => setEditor({ ...editor, name })}
                >{name}</button>
              ))}
            </div>
            <input
              className="text-input compact"
              value={editor.name}
              maxLength={80}
              aria-label={t.zoneName}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
            />
            <div className="radius-control">
              <span>{t.zoneRadius}</span>
              <input
                type="range" min="50" max="1000" step="10"
                value={editor.radiusM}
                onChange={(event) => setEditor({ ...editor, radiusM: Number(event.target.value) })}
              />
              <strong>{editor.radiusM}m</strong>
            </div>
            <button className="btn primary" onClick={saveZone} disabled={saving || !editor.name.trim()}>
              {saving && <span className="spinner small" />}
              {editor.mode === 'edit' ? t.updateZone : t.saveZone}
            </button>
          </div>
        )}
      </section>

      {mapMode === 'history' && historyPoints.length > 0 && (
        <section className="history-playback-card">
          <div className="history-playback-head">
            <div><strong>{t.routeHistory}</strong><span>{timeAgo(playbackPoint?.captured_at ?? playbackPoint?.received_at, t)}</span></div>
            <b>{playbackIndex + 1}/{historyPoints.length}</b>
          </div>
          <input
            type="range"
            min="0"
            max={Math.max(0, historyPoints.length - 1)}
            value={Math.min(playbackIndex, Math.max(0, historyPoints.length - 1))}
            onChange={handlePlaybackChange}
            aria-label={t.routeTimeline}
          />
          <div className="history-summary">
            <span><strong>{distanceLabel(history?.summary?.distance_m)}</strong>{t.routeDistance}</span>
            <span><strong>{history?.summary?.point_count ?? 0}</strong>{t.routeSamples}</span>
            <span className={(history?.summary?.gap_count ?? 0) > 0 ? 'warning' : ''}><strong>{history?.summary?.gap_count ?? 0}</strong>{t.routeGaps}</span>
          </div>
          {(history?.summary?.gap_count ?? 0) > 0 && <p>{t.routeGapHelp}</p>}
        </section>
      )}

      {!editor && mapMode === 'live' && (
        <button className="btn primary create-zone-btn" onClick={() => startEditor()} disabled={!canEdit || !hasLocation(latest)}>
          <ShieldIcon />{t.createSafeZone}
        </button>
      )}

      <section className="map-insight-grid">
        <article className="map-insight">
          <RouteMetricIcon />
          <span>{mapMode === 'history' ? t.routeHistory : t.recentTrail}</span>
          <strong>{mapMode === 'history' ? distanceLabel(history?.summary?.distance_m) : t.trailPoints(displayTrail.length)}</strong>
        </article>
        <article className={`map-insight ${quality}`}>
          <SatelliteIcon />
          <span>{t.zoneGpsAccuracy}</span>
          <strong>{hasLocation(displayLatest) ? `±${Math.round(Number(displayLatest.gps_accuracy_m ?? 15))}m` : '—'}</strong>
        </article>
      </section>

      <section className="card zone-section">
        <div className="card-title">
          <h2><ShieldIcon />{t.safeZones}</h2>
          <span className="pill">{normalizedZones.filter((zone) => zone.status === 'active').length}</span>
        </div>
        {normalizedZones.length === 0 ? (
          <div className="empty-state compact"><ShieldIcon /><p>{t.noZonesYet}</p></div>
        ) : (
          <div className="zone-list enterprise">
            {normalizedZones.map((zone) => (
              <button
                className="zone-card"
                key={zone.id}
                onClick={() => { setSelectedZone(zone); haptic.light(); }}
              >
                <span className="zone-icon" style={{ '--zone-color': zoneColor(zone) }}><ShieldIcon /></span>
                <span className="zone-main">
                  <strong>{zone.name}</strong>
                  <span>{t[`zoneState_${zone.stateValue}`] ?? t.zoneState_UNKNOWN}</span>
                </span>
                <span className="zone-meta"><strong>{Math.round(zone.radiusM)}m</strong><small>{zone.status === 'active' ? t.active : t.pause}</small></span>
              </button>
            ))}
          </div>
        )}
      </section>

      {canEdit && (
        <section className="smart-zone-card">
          <div className="smart-zone-head">
            <span className="smart-zone-icon"><SparklesIcon /></span>
            <div><h2>{t.smartZones}</h2><p>{t.smartZonesBody}</p></div>
          </div>
          {!suggestions ? (
            <div className="smart-learning"><span className="spinner small" />{t.learningPlaces}</div>
          ) : suggestions.suggestions?.length ? (
            <div className="suggestion-list">
              {suggestions.suggestions.map((suggestion) => (
                <article className="suggestion-card" key={suggestion.id}>
                  <div className="suggestion-top">
                    <span><PinIcon /></span>
                    <div><strong>{suggestion.name}</strong><small>{t.suggestionEvidence(suggestion.distinct_days, suggestion.sample_count)}</small></div>
                    <b>{t.suggestionConfidence(Math.round(suggestion.confidence * 100))}</b>
                  </div>
                  <div className="suggestion-actions">
                    <button className="btn small" onClick={() => acceptSuggestion(suggestion)} disabled={suggestionBusy === suggestion.id}>
                      {t.acceptSuggestion}
                    </button>
                    <button className="btn ghost small" onClick={() => dismissSuggestion(suggestion)} disabled={suggestionBusy === suggestion.id}>
                      {t.dismissSuggestion}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="learning-progress">
              <div className="learning-copy"><strong>{t.learningPlaces}</strong><span>{t.noSuggestionYet}</span></div>
              <div className="progress-track"><span style={{ width: `${Math.min(100,
                (Math.min(3, suggestions.progress?.distinct_days ?? 0) / 3) * 50
                + (Math.min(12, suggestions.progress?.eligible_samples ?? 0) / 12) * 50,
              )}%` }} /></div>
              <small>{t.learningProgress(suggestions.progress?.distinct_days ?? 0, suggestions.progress?.eligible_samples ?? 0)}</small>
            </div>
          )}
        </section>
      )}

      <p className="map-attribution-note">{t.freeMapProvider}</p>

      <Sheet open={!!selectedZone} onClose={() => setSelectedZone(null)} closeLabel={t.cancel}>
        {selectedZone && (
          <>
            <div className="zone-detail-hero" style={{ '--zone-color': zoneColor(selectedZone) }}>
              <span><ShieldIcon /></span>
              <div><small>{t.zoneDetails}</small><h2>{selectedZone.name}</h2></div>
              <b>{selectedZone.status === 'active' ? t.zoneStatusActive : t.zoneStatusPaused}</b>
            </div>
            <div className="zone-detail-grid">
              <div><span>{t.zoneRadius}</span><strong>{Math.round(selectedZone.radiusM)}m</strong></div>
              <div><span>{t.zoneDistance}</span><strong>{selectedZone.state?.distance_m == null ? '—' : `${Math.round(selectedZone.state.distance_m)}m`}</strong></div>
              <div><span>{t.zoneGpsAccuracy}</span><strong>{selectedZone.state?.accuracy_m == null ? '—' : `±${Math.round(selectedZone.state.accuracy_m)}m`}</strong></div>
              <div><span>{t.zoneUpdatedAt}</span><strong>{timeAgo(selectedZone.state?.sample_at, t)}</strong></div>
            </div>
            <div className="zone-detail-state" style={{ '--zone-color': zoneColor(selectedZone) }}>
              <span className="zone-live-dot" />
              <div><strong>{t[`zoneState_${selectedZone.stateValue}`] ?? t.zoneState_UNKNOWN}</strong><span>{selectedZone.status === 'active' ? t.zoneStatusActive : t.zoneStatusPaused}</span></div>
            </div>
            {canEdit && !String(selectedZone.id).startsWith('legacy-') && (
              <div className="sheet-actions split">
                <button className="btn" onClick={() => startEditor(selectedZone)}><EditIcon />{t.edit}</button>
                <button
                  className="btn ghost"
                  disabled={zoneBusy === selectedZone.id}
                  onClick={() => setZoneStatus(selectedZone, selectedZone.status === 'active' ? 'paused' : 'active')}
                >{selectedZone.status === 'active' ? t.pause : t.activate}</button>
                <button className="btn ghost danger" onClick={() => { setDeleteZone(selectedZone); setSelectedZone(null); }}>
                  <TrashIcon />{t.delete}
                </button>
              </div>
            )}
          </>
        )}
      </Sheet>

      <Sheet open={!!deleteZone} onClose={() => setDeleteZone(null)} closeLabel={t.cancel}>
        <div className="sheet-title danger"><TrashIcon />{t.deleteZoneTitle}</div>
        <p className="sheet-body">{t.deleteZoneBody}</p>
        <div className="sheet-actions">
          <button className="btn danger primary" onClick={confirmDelete} disabled={zoneBusy === deleteZone?.id}>{t.confirmDelete}</button>
          <button className="btn ghost primary" onClick={() => setDeleteZone(null)}>{t.cancel}</button>
        </div>
      </Sheet>
    </div>
  );
}

function RouteMetricIcon() {
  return <ClockIcon />;
}
