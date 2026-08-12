/**
 * Shared SVG icon set (inline, no emoji — keeps the UI professional
 * and consistent across platforms).
 */

const I = ({ children, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    {children}
  </svg>
);

export const BikeIcon = (p) => (
  <I {...p}>
    <circle cx="6" cy="17" r="3.2" />
    <circle cx="18" cy="17" r="3.2" />
    <path d="M6 17 9.5 9.5h4L18 17" />
    <path d="M9.5 9.5 8 6h2.5" />
    <path d="M13.5 9.5 15 5h2" />
  </I>
);

export const ShieldIcon = (p) => (
  <I {...p}>
    <path d="M12 3 5 6v5c0 4.4 3 8.4 7 9.5 4-1.1 7-5.1 7-9.5V6l-7-3z" />
    <path d="m9 12 2 2 4-4" />
  </I>
);

export const ShieldOffIcon = (p) => (
  <I {...p}>
    <path d="M12 3 5 6v5c0 4.4 3 8.4 7 9.5 4-1.1 7-5.1 7-9.5V6l-7-3z" />
    <path d="m9.5 9.5 5 5" />
    <path d="m14.5 9.5-5 5" />
  </I>
);

export const BatteryIcon = (p) => (
  <I {...p}>
    <rect x="2" y="8" width="17" height="9" rx="2.5" />
    <path d="M22 11v3" />
  </I>
);

export const GaugeIcon = (p) => (
  <I {...p}>
    <path d="M12 15a7.5 7.5 0 1 1 7.5-7.5" transform="rotate(45 12 12)" />
    <path d="M12 13 16 9" />
    <path d="M4 18h16" />
  </I>
);

export const SatelliteIcon = (p) => (
  <I {...p}>
    <path d="m13 7 4-4 4 4-4 4z" />
    <path d="m9 11 4 4" />
    <path d="m13 7-4 4" />
    <path d="m17 11-4 4" />
    <path d="M7.5 13.5a4.5 4.5 0 0 0-6 6" />
    <path d="M10.5 10.5a8 8 0 0 0-9 9" />
  </I>
);

export const ClockIcon = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </I>
);

export const PinIcon = (p) => (
  <I {...p}>
    <path d="M12 21s7-5.1 7-11a7 7 0 1 0-14 0c0 5.9 7 11 7 11z" />
    <circle cx="12" cy="10" r="2.5" />
  </I>
);

export const CardIcon = (p) => (
  <I {...p}>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="M3 10h18" />
    <path d="M7 15h4" />
  </I>
);

export const BellIcon = (p) => (
  <I {...p}>
    <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </I>
);

export const RouteIcon = (p) => (
  <I {...p}>
    <circle cx="6" cy="19" r="2.5" />
    <circle cx="18" cy="5" r="2.5" />
    <path d="M8.5 19H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" />
  </I>
);

export const SunIcon = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </I>
);

export const MoonIcon = (p) => (
  <I {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
  </I>
);

export const RefreshIcon = (p) => (
  <I {...p}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 3v6h-6" />
  </I>
);

export const CheckCircleIcon = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.5 2.5 2.5 5-5" />
  </I>
);

export const LockIcon = (p) => (
  <I {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2.5" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </I>
);

export const UnlockIcon = (p) => (
  <I {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2.5" />
    <path d="M8 11V8a4 4 0 0 1 7.5-2" />
  </I>
);

export const HomeIcon = (p) => (
  <I {...p}>
    <path d="m3 10.5 9-7.5 9 7.5" />
    <path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5" />
  </I>
);

export const UserIcon = (p) => (
  <I {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
  </I>
);

export const AlertIcon = (p) => (
  <I {...p}>
    <path d="M12 4 2.5 20h19L12 4z" />
    <path d="M12 10v4" />
    <path d="M12 17.2v.3" />
  </I>
);

export const ExternalIcon = (p) => (
  <I {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M19 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5.5" />
  </I>
);

export const InfoIcon = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 7.8v.3" />
  </I>
);

export const XIcon = (p) => (
  <I {...p}>
    <path d="m6 6 12 12" />
    <path d="m18 6-12 12" />
  </I>
);

export const EditIcon = (p) => (
  <I {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" />
  </I>
);

export const LayersIcon = (p) => (
  <I {...p}>
    <path d="m12 3-9 5 9 5 9-5z" />
    <path d="m3 12 9 5 9-5" />
    <path d="m3 16 9 5 9-5" />
  </I>
);

export const SparklesIcon = (p) => (
  <I {...p}>
    <path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2z" />
    <path d="m18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7z" />
    <path d="m5 13 .7 2.3 2.3.7-2.3.7L5 19l-.7-2.3L2 16l2.3-.7z" />
  </I>
);

export const NavigationIcon = (p) => (
  <I {...p}>
    <path d="m4 4 16 7-7 2-2 7z" />
  </I>
);

export const ChevronRightIcon = (p) => (
  <I {...p}>
    <path d="m9 18 6-6-6-6" />
  </I>
);

export const TrashIcon = (p) => (
  <I {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="m6 7 1 14h10l1-14" />
    <path d="M10 11v6M14 11v6" />
  </I>
);

export const WifiIcon = (p) => (
  <I {...p}>
    <path d="M4.9 9.7a11 11 0 0 1 14.2 0" />
    <path d="M7.8 13a6.5 6.5 0 0 1 8.4 0" />
    <path d="M10.6 16.2a2.2 2.2 0 0 1 2.8 0" />
    <circle cx="12" cy="19" r=".7" fill="currentColor" stroke="none" />
  </I>
);

export const PhoneIcon = (p) => (
  <I {...p}>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M10 5h4M11 18.5h2" />
  </I>
);

export const CloudIcon = (p) => (
  <I {...p}>
    <path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 8.4 4.8 4.8 0 0 0 7 18z" />
  </I>
);

export const SignalIcon = (p) => (
  <I {...p}>
    <path d="M5 20v-3M10 20v-7M15 20V9M20 20V4" />
  </I>
);

export const ToolsIcon = (p) => (
  <I {...p}>
    <path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7 5 1.4a4 4 0 0 0 5 5l-7.6 7.6a2 2 0 0 0 2.8 2.8l7.6-7.6a4 4 0 0 0 5-5L15.5 6.5 13 4l2.3-2.3" />
    <path d="m5.5 12.5 2 2" />
  </I>
);
