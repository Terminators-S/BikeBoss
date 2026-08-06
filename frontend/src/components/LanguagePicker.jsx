import { useLanguage } from './LanguageProvider.jsx';

export default function LanguagePicker() {
  const { lang, t, setLang } = useLanguage();

  return (
    <div className="lang-picker" title={t.language}>
      <button
        className={`lang-btn ${lang === 'en' ? 'active' : ''}`}
        onClick={() => setLang('en')}
      >
        EN
      </button>
      <button
        className={`lang-btn ${lang === 'km' ? 'active' : ''}`}
        onClick={() => setLang('km')}
      >
        ខ្មែរ
      </button>
    </div>
  );
}
