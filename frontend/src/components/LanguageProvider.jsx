import { useState, useEffect, createContext, useContext } from 'react';
import { translations, SUPPORTED_LANGUAGES, persistLanguage } from '../i18n.js';
import { api, getTelegramContext } from '../api.js';

const LanguageContext = createContext(null);

/**
 * Language is the SINGLE source of truth across the whole system:
 * stored in D1 (users.language), shared by bot + Mini App.
 *
 * Resolution order on app load:
 *   1. Backend profile (if opened inside Telegram) — always wins
 *   2. localStorage (demo mode / outside Telegram)
 *   3. Telegram UI language hint
 *   4. 'en'
 *
 * Changing language in the app writes back to D1 → bot alerts switch too.
 */
export function LanguageProvider({ children }) {
  const tg = getTelegramContext();
  const [lang, setLangState] = useState(() => {
    // Immediate fallback while backend responds
    try {
      const saved = localStorage.getItem('bikeboss_lang');
      if (saved && SUPPORTED_LANGUAGES.includes(saved)) return saved;
    } catch { /* ignore */ }
    const tgLang = tg?.initData
      ? window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code
      : null;
    return tgLang?.startsWith('km') ? 'km' : 'en';
  });

  // Sync from backend (authoritative) once on mount
  useEffect(() => {
    if (!tg?.userId) return;
    api.getLanguage(tg.userId)
      .then(({ language }) => {
        if (language && SUPPORTED_LANGUAGES.includes(language) && language !== lang) {
          setLangState(language);
          persistLanguage(language);
        }
      })
      .catch(() => { /* offline demo — keep local choice */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tg?.userId]);

  const setLang = (next) => {
    setLangState(next);
    persistLanguage(next);
    // Write through to backend so the bot follows the same language
    if (tg?.userId) {
      api.setLanguage(tg.userId, next).catch(() => {});
    }
  };

  return (
    <LanguageContext.Provider value={{ lang, t: translations[lang], setLang }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
