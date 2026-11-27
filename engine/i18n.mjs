import en from './i18n/en.json' with { type: 'json' };
import ptBR from './i18n/pt-BR.json' with { type: 'json' };

const TABLES = { en, 'pt-BR': ptBR };
const EXTRA = { en: { approve: [], redo: [] }, 'pt-BR': { approve: ['/aprovar'], redo: ['/refazer'] } };

export const languages = () => Object.keys(TABLES);

export function t(lang, key, vars = {}) {
  const s = TABLES[lang]?.[key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

export function aliases(lang) {
  const x = EXTRA[lang] ?? EXTRA.en;
  return { approve: ['/approve', ...x.approve], redo: ['/redo', ...x.redo] };
}

export const strings = (lang, prefix) => Object.fromEntries(Object.keys(en).filter((k) => k.startsWith(prefix)).map((k) => [k, t(lang, k)]));
