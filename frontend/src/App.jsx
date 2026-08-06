import { useEffect, useState, useCallback } from 'react';
import { api, getTelegramContext, DEMO_DEVICE_ID } from './api.js';
import { LanguageProvider, useLanguage } from './components/LanguageProvider.jsx';
import LanguagePicker from './components/LanguagePicker.jsx';
import StatusCard from './components/StatusCard.jsx';
import LocationCard from './components/LocationCard.jsx';
import EventsList from './components/EventsList.jsx';
import TripsList from './components/TripsList.jsx';
import SubscribeCard from './components/SubscribeCard.jsx';

function AppShell() {
  const tg = getTelegramContext();
  const { t } = useLanguage();
  const [deviceId] = useState(DEMO_DEVICE_ID);
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
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="app">
      <header className="header">
        <h1>🏍️ {t.appTitle}</h1>
        <div className="header-right">
          {tg && <span className="user">{t.greeting(tg.firstName)}</span>}
          <LanguagePicker />
        </div>
      </header>

      {!tg && (
        <div className="banner">
          {t.demoMode} <code>{deviceId}</code>.
        </div>
      )}

      {error && <div className="banner error">⚠️ {error}</div>}
      {loading && <div className="loading">{t.loading}</div>}

      {data && (
        <>
          <StatusCard device={data.device} latest={data.latest_telemetry} onRefresh={refresh} />
          <LocationCard latest={data.latest_telemetry} geofences={data.geofences} />
          <SubscribeCard device={data.device} telegramId={tg?.userId} />
          <EventsList events={data.recent_events} />
          <TripsList deviceId={deviceId} />
        </>
      )}
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AppShell />
    </LanguageProvider>
  );
}
