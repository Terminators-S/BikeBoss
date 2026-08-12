import { lazy, Suspense, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api, getTelegramContext, haptic, DEMO_DEVICE_ID } from './api.js';
import { LanguageProvider, useLanguage } from './components/LanguageProvider.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { HomeSkeleton, ActivitySkeleton, AccountSkeleton, MapSkeleton } from './components/Skeleton.jsx';
import UserAvatar from './components/UserAvatar.jsx';
import HomeScreen, { ErrorState } from './screens/HomeScreen.jsx';
import ActivityScreen from './screens/ActivityScreen.jsx';
import AccountScreen from './screens/AccountScreen.jsx';
import Onboarding from './screens/Onboarding.jsx';
import { getSavedThemePref, saveThemePref, resolveTheme } from './theme.js';
import {
  BikeIcon, SunIcon, MoonIcon, HomeIcon, RouteIcon, UserIcon,
  PinIcon, SparklesIcon, XIcon,
} from './components/icons.jsx';

const REFRESH_MS = 5_000;
const ACTIVITY_REFRESH_MS = 8_000;
const ANNOUNCED_FIRMWARE_BUILD = 2026081205;
const ANNOUNCEMENT_STORAGE_KEY = `bikeboss-update-${ANNOUNCED_FIRMWARE_BUILD}-dismissed`;
const DEVELOPER_TOOLS_ENABLED = import.meta.env.DEV
  || import.meta.env.VITE_ENABLE_DEVELOPER_TOOLS === 'true';
const VALID_TABS = new Set([
  'home', 'map', 'activity', 'account',
  ...(DEVELOPER_TOOLS_ENABLED ? ['developer'] : []),
]);
const MapScreen = lazy(() => import('./screens/MapScreen.jsx'));
const DeveloperScreen = lazy(() => import('./screens/DeveloperScreen.jsx'));

function initialTab() {
  const candidate = window.location.hash.replace('#', '');
  return VALID_TABS.has(candidate) ? candidate : 'home';
}

function AppShell() {
  const tg = useMemo(() => getTelegramContext(), []);
  const { t } = useLanguage();
  // ---- boot / data state ----
  const [bootState, setBootState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [me, setMe] = useState(null);
  const [activity, setActivity] = useState(null);
  const [tab, setTab] = useState(initialTab);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [activityFailed, setActivityFailed] = useState(false);
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine !== false);
  const [announcementDismissed, setAnnouncementDismissed] = useState(
    () => localStorage.getItem(ANNOUNCEMENT_STORAGE_KEY) === '1',
  );
  const [firmwareUpdateRequested, setFirmwareUpdateRequested] = useState(false);
  const meRef = useRef(null);
  const meRequestRef = useRef(null);
  const activityRequestRef = useRef(null);

  useEffect(() => { meRef.current = me; }, [me]);

  // ---- theme ----
  const [themePref, setThemePref] = useState(getSavedThemePref);
  const [resolved, setResolved] = useState(() => resolveTheme(getSavedThemePref(), tg?.colorScheme));

  useEffect(() => {
    setResolved(resolveTheme(themePref, tg?.colorScheme));
  }, [themePref, tg?.colorScheme]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    window.Telegram?.WebApp?.setHeaderColor?.(resolved === 'dark' ? '#0b101b' : '#2563eb');
    window.Telegram?.WebApp?.setBackgroundColor?.(resolved === 'dark' ? '#0b101b' : '#eef1f6');
  }, [resolved]);

  const changeTheme = (pref) => {
    setThemePref(pref);
    saveThemePref(pref);
  };

  // ---- Telegram chrome ----
  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    webApp?.ready?.();
    webApp?.expand?.();
  }, []);

  useEffect(() => {
    const online = () => setNetworkOnline(true);
    const offline = () => setNetworkOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  // ---- data loading ----
  const telegramId = tg?.userId ?? null;
  const isDemo = !telegramId;

  const loadMe = useCallback(() => {
    if (meRequestRef.current) return meRequestRef.current;
    const request = (async () => {
      try {
        let data;
        if (isDemo) {
          const status = await api.deviceStatus(DEMO_DEVICE_ID);
          data = { user: null, devices: [{
            ...status.device,
            latest_telemetry: status.latest_telemetry,
            connectivity: status.connectivity,
            geofences: status.geofences,
          }] };
        } else {
          await api.startSession(tg?.initData);
          data = await api.meSecure();
        }
        setMe(data);
        setBootState('ready');
        setNetworkOnline(true);
      } catch {
        if (!meRef.current) setBootState('error');
        else setNetworkOnline(false);
      }
    })();
    meRequestRef.current = request;
    request.finally(() => {
      if (meRequestRef.current === request) meRequestRef.current = null;
    });
    return request;
  }, [isDemo, tg?.initData]);

  useEffect(() => {
    loadMe();
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') loadMe();
    };
    const timer = setInterval(refreshVisible, REFRESH_MS);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refreshVisible);
    };
  }, [loadMe]);

  const device = me?.devices?.[0] ?? null;
  const showUpdateAnnouncement = bootState === 'ready' && device
    && !announcementDismissed;

  // Lazy-load activity the first time the tab opens
  const loadActivity = useCallback(() => {
    if (activityRequestRef.current) return activityRequestRef.current;
    const request = (async () => {
      setActivityFailed(false);
      try {
        let data;
        if (isDemo) {
          const [status, trips] = await Promise.all([
            api.deviceStatus(DEMO_DEVICE_ID),
            api.trips(DEMO_DEVICE_ID),
          ]);
          data = { trips, events: status.recent_events || [] };
        } else {
          data = await api.activitySecure();
        }
        setActivity(data);
        setActivityLoaded(true);
      } catch {
        setActivityFailed(true);
      }
    })();
    activityRequestRef.current = request;
    request.finally(() => {
      if (activityRequestRef.current === request) activityRequestRef.current = null;
    });
    return request;
  }, [isDemo, telegramId]);

  useEffect(() => {
    if (tab !== 'activity' || !device) return undefined;
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') loadActivity();
    };
    refreshVisible();
    const timer = setInterval(refreshVisible, ACTIVITY_REFRESH_MS);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refreshVisible);
    };
  }, [tab, device, loadActivity]);

  // ---- tab switching with haptic ----
  const switchTab = (next) => {
    if (next === tab) return;
    haptic.select();
    setTab(next);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${next}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const heroGreeting = useMemo(() => {
    const name = me?.user?.display_name || tg?.firstName;
    return name ? t.greeting(name) : null;
  }, [me, tg, t]);

  const profileName = me?.user?.display_name
    || [tg?.firstName, tg?.lastName].filter(Boolean).join(' ')
    || tg?.username
    || '';

  // ---- render ----
  const showOnboarding = bootState === 'ready' && !device;
  const showNav = bootState === 'ready' && !!device;

  return (
    <div className="app">
      {/* Hero header */}
      <header className={`hero ${tab === 'map' ? 'compact' : ''}`}>
        <div className="hero-top">
          <div className="brand">
            <div className="brand-badge"><BikeIcon /></div>
            <div>
              <div className="brand-name">{t.appTitle}</div>
              <div className="brand-tag">{t.tagline}</div>
            </div>
          </div>
          <div className="hero-controls">
            {tg && (
              <button
                className="avatar-btn"
                onClick={() => switchTab('account')}
                aria-label={t.navAccount}
              >
                <UserAvatar photoUrl={tg.photoUrl} name={profileName} className="header-avatar" />
              </button>
            )}
            <button
              className="icon-btn"
              onClick={() => {
                haptic.light();
                changeTheme(resolved === 'dark' ? 'light' : 'dark');
              }}
              aria-label="Toggle theme"
            >
              {resolved === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>
        {heroGreeting && <div className="hero-user">{heroGreeting}</div>}
      </header>

      {isDemo && bootState === 'ready' && (
        <div className="banner">
          {t.demoMode} <code>{DEMO_DEVICE_ID}</code>
        </div>
      )}

      {!networkOnline && bootState === 'ready' && (
        <div className="banner warning">{t.networkOffline}</div>
      )}

      {showUpdateAnnouncement && (
        <aside className="update-announcement" role="status">
          <span className="update-announcement-icon"><SparklesIcon /></span>
          <span className="update-announcement-copy">
            <strong>{t.updateAnnouncementTitle}</strong>
            <small>{t.updateAnnouncementBody}</small>
            <button type="button" onClick={() => {
              setFirmwareUpdateRequested(true);
              switchTab('account');
            }}>
              {t.updateAnnouncementAction}
            </button>
          </span>
          <button
            className="update-announcement-close"
            type="button"
            aria-label={t.dismissAnnouncement}
            onClick={() => {
              localStorage.setItem(ANNOUNCEMENT_STORAGE_KEY, '1');
              setAnnouncementDismissed(true);
              haptic.light();
            }}
          ><XIcon /></button>
        </aside>
      )}

      {bootState === 'loading' && <HomeSkeleton />}

      {bootState === 'error' && <ErrorState onRetry={loadMe} />}

      {showOnboarding && (
        <Onboarding
          telegramId={telegramId}
          tgUser={tg}
          onLinked={loadMe}
        />
      )}

      {bootState === 'ready' && device && tab === 'home' && (
        <HomeScreen
          key="home"
          device={device}
          latest={device.latest_telemetry}
          geofences={device.geofences}
          tgUser={tg}
          onRefresh={loadMe}
          onNavigate={switchTab}
        />
      )}

      {bootState === 'ready' && device && tab === 'activity' && (
        activityFailed ? <ErrorState onRetry={loadActivity} />
        : !activityLoaded ? <ActivitySkeleton />
        : <ActivityScreen
          key="activity"
          trips={activity?.trips || []}
          events={activity?.events || []}
          onRefresh={loadActivity}
          canLoadTripDetail={!isDemo}
        />
      )}

      {bootState === 'ready' && device && tab === 'map' && (
        <Suspense fallback={<MapSkeleton />}>
          <MapScreen
            key="map"
            device={device}
            latest={device.latest_telemetry}
            zones={device.geofences || []}
            canEdit={!isDemo}
            onRefresh={loadMe}
          />
        </Suspense>
      )}

      {bootState === 'ready' && device && tab === 'account' && (
        <AccountScreen
          key="account"
          device={device}
          user={me?.user}
          tgUser={tg}
          telegramId={telegramId}
          themePref={themePref}
          onThemeChange={changeTheme}
          onRefresh={loadMe}
          developerToolsEnabled={DEVELOPER_TOOLS_ENABLED && (!isDemo || import.meta.env.DEV)}
          onOpenDeveloper={() => switchTab('developer')}
          openFirmwareUpdate={firmwareUpdateRequested}
          onFirmwareUpdateOpened={() => setFirmwareUpdateRequested(false)}
        />
      )}

      {bootState === 'ready' && device && tab === 'developer' && DEVELOPER_TOOLS_ENABLED && (
        <Suspense fallback={<AccountSkeleton />}>
          <DeveloperScreen
            key="developer"
            device={device}
            isDemo={isDemo}
            onNavigate={switchTab}
            onRefresh={loadMe}
          />
        </Suspense>
      )}

      {/* Bottom navigation */}
      {showNav && (
        <nav className="bottom-nav">
          <div className="bottom-nav-inner">
            <button
              className={`nav-item ${tab === 'home' ? 'active' : ''}`}
              onClick={() => switchTab('home')}
            >
              <HomeIcon />
              {t.navHome}
            </button>
            <button
              className={`nav-item ${tab === 'map' ? 'active' : ''}`}
              onClick={() => switchTab('map')}
            >
              <PinIcon />
              {t.navMap}
            </button>
            <button
              className={`nav-item ${tab === 'activity' ? 'active' : ''}`}
              onClick={() => switchTab('activity')}
            >
              <RouteIcon />
              {t.navActivity}
            </button>
            <button
              className={`nav-item ${tab === 'account' || tab === 'developer' ? 'active' : ''}`}
              onClick={() => switchTab('account')}
            >
              <UserIcon />
              {t.navAccount}
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </LanguageProvider>
  );
}
