import { useEffect, useState, useCallback } from 'react';
import { api, getTelegramContext, DEMO_DEVICE_ID } from './api.js';
import StatusCard from './components/StatusCard.jsx';
import LocationCard from './components/LocationCard.jsx';
import EventsList from './components/EventsList.jsx';
import TripsList from './components/TripsList.jsx';
import SubscribeCard from './components/SubscribeCard.jsx';

export default function App() {
  const tg = getTelegramContext();
  const [deviceId, setDeviceId] = useState(DEMO_DEVICE_ID);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const status = await api.deviceStatus(deviceId);
      setData(status);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15000); // poll every 15s
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="app">
      <header className="header">
        <h1>🏍️ BikeBoss</h1>
        {tg && <span className="user">Hi, {tg.firstName}</span>}
      </header>

      {!tg && (
        <div className="banner">
          Demo mode — opened outside Telegram. Using device{' '}
          <code>{deviceId}</code>.
        </div>
      )}

      {error && <div className="banner error">⚠️ {error}</div>}
      {loading && <div className="loading">Loading…</div>}

      {data && (
        <>
          <StatusCard
            device={data.device}
            latest={data.latest_telemetry}
            onRefresh={refresh}
          />
          <LocationCard latest={data.latest_telemetry} geofences={data.geofences} />
          <SubscribeCard device={data.device} telegramId={tg?.userId} />
          <EventsList events={data.recent_events} />
          <TripsList deviceId={deviceId} />
        </>
      )}
    </div>
  );
}
