/**
 * i18n — English / Khmer (ភាសាខ្មែរ) strings for the BikeBoss Mini App.
 *
 * Language priority: user profile (backend) → Telegram UI language → 'en'.
 */

export const translations = {
  en: {
    appTitle: 'BikeBoss',
    greeting: (name) => `Hi, ${name}`,
    demoMode: 'Demo mode — opened outside Telegram. Using device',
    loading: 'Loading…',

    // Status card
    myBike: 'My Bike',
    disarmed: 'Disarmed',
    armed: 'Armed',
    pendingUnlock: 'Pending Unlock',
    battery: 'Battery',
    speed: 'Speed',
    gps: 'GPS',
    gpsFixed: 'Fixed',
    gpsNoFix: 'No fix',
    lastSeen: 'Last seen',
    never: 'never',
    armHint: 'Remote arm/disarm lands on the next device heartbeat — use the bot commands /arm and /disarm to queue them.',

    // Location
    location: 'Location',
    noGpsFix: 'No GPS fix right now.',
    openInMaps: '🗺️ Open in Maps',
    activeGeofences: 'Active geofences',

    // Subscription
    subscription: 'Subscription',
    expires: 'Expires',
    renewal: 'Renewal',
    perYear: '/ year',
    extendBtn: '💳 Extend ($15/Year)',
    creatingInvoice: 'Creating invoice…',
    scanWith: 'Scan with ABA Mobile / Bakong:',
    openInTelegramToRenew: 'Open inside Telegram to renew.',

    // Events
    recentEvents: 'Recent Events',
    noEvents: 'No events yet.',

    // Trips
    recentTrips: 'Recent Trips',
    noTrips: 'No trips recorded yet.',
    maxSpeed: 'Max',
    safety: 'Safety',
    eco: 'Eco',

    // Language picker
    language: 'Language',
    english: 'English',
    khmer: 'ខ្មែរ',
  },

  km: {
    appTitle: 'BikeBoss',
    greeting: (name) => `សួស្តី, ${name}`,
    demoMode: 'របៀបសាកល្បង — បើកក្រៅ Telegram។ កំពុងប្រើឧបករណ៍',
    loading: 'កំពុងផ្ទុក…',

    myBike: 'ម៉ូតូរបស់ខ្ញុំ',
    disarmed: 'បើកប្រព័ន្ធ',
    armed: 'បិទប្រព័ន្ធ (ការពារ)',
    pendingUnlock: 'រង់ចាំការបើក',
    battery: 'ថ្ម',
    speed: 'ល្បឿន',
    gps: 'GPS',
    gpsFixed: 'មានសញ្ញា',
    gpsNoFix: 'គ្មានសញ្ញា',
    lastSeen: 'ឃើញចុងក្រោយ',
    never: 'មិនធ្លាប់',
    armHint: 'ការបើក/បិទពីចម្ងាយនឹងមានប្រសិទ្ធភាពនៅ heartbeat បន្ទាប់ — ប្រើពាក្យបញ្ជា /arm និង /disarm ក្នុង bot។',

    location: 'ទីតាំង',
    noGpsFix: 'គ្មានសញ្ញា GPS ឥឡូវនេះទេ។',
    openInMaps: '🗺️ បើកក្នុងផែនទី',
    activeGeofences: 'តំបន់ការពារសកម្ម',

    subscription: 'ការជាវ',
    expires: 'ផុតកំណត់',
    renewal: 'បន្ត',
    perYear: '/ ឆ្នាំ',
    extendBtn: '💳 បន្ត ($15/ឆ្នាំ)',
    creatingInvoice: 'កំពុងបង្កើតវិក្កយបត្រ…',
    scanWith: 'ស្កេនជាមួយ ABA Mobile / Bakong:',
    openInTelegramToRenew: 'បើកក្នុង Telegram ដើម្បីបន្ត។',

    recentEvents: 'ព្រឹត្តិការណ៍ថ្មីៗ',
    noEvents: 'មិនទាន់មានព្រឹត្តិការណ៍ទេ។',

    recentTrips: 'ដំណើរថ្មីៗ',
    noTrips: 'មិនទាន់មានដំណើរទេ។',
    maxSpeed: 'អតិបរមា',
    safety: 'សុវត្ថិភាព',
    eco: 'សន្សំ',

    language: 'ភាសា',
    english: 'English',
    khmer: 'ខ្មែរ',
  },
};

export const SUPPORTED_LANGUAGES = ['en', 'km'];

export function persistLanguage(lang) {
  try {
    localStorage.setItem('bikeboss_lang', lang);
  } catch { /* ignore */ }
}
