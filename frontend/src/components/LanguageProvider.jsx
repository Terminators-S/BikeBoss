import { useState, createContext, useContext } from 'react';
import { translations, resolveInitialLanguage, persistLanguage } from '../i18n.js';

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [lang, setLang] = useState(resolveInitialLanguage);

  const changeLanguage = (next) => {
    setLang(next);
    persistLanguage(next);
  };

  return (
    <LanguageContext.Provider value={{ lang, t: translations[lang], setLang: changeLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
