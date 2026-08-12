/**
 * Theme controller — light / dark / auto (follows Telegram + OS).
 * Persists to localStorage ('bikeboss_theme': 'light' | 'dark' | 'auto').
 */

const KEY = 'bikeboss_theme';

export function getSavedThemePref() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch { /* ignore */ }
  return 'auto';
}

export function saveThemePref(pref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch { /* ignore */ }
}

/** Resolve a preference to an actual theme. */
export function resolveTheme(pref, tgColorScheme) {
  if (pref === 'light' || pref === 'dark') return pref;
  if (tgColorScheme === 'light' || tgColorScheme === 'dark') return tgColorScheme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
