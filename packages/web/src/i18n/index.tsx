import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_LOCALE, LOCALES } from '@inventory/shared';
import type { Locale } from '@inventory/shared';
import en from './en.json';
import de from './de.json';
import ca from './ca.json';

// UI-string i18n: t('nav.home') looks up the active locale,
// falls back to EN, then to the key itself. Adding a locale = one JSON file.
// (Entity *data* names use resolveText from @inventory/shared instead.)

type Dictionary = { [key: string]: string | Dictionary };
const dictionaries: Record<Locale, Dictionary> = { en, de, ca };

const STORAGE_KEY = 'locale';

function lookup(dict: Dictionary, key: string): string | undefined {
  let node: string | Dictionary | undefined = dict;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === undefined) return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** `t('lots.itemsCreated', { n: 6 })` → "6 items created". */
export type TParams = Record<string, string | number>;

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function loadStoredLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  return (LOCALES as readonly string[]).includes(stored ?? '')
    ? (stored as Locale)
    : DEFAULT_LOCALE;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(loadStoredLocale);

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    localStorage.setItem(STORAGE_KEY, next);
  };

  const t = (key: string, params?: TParams): string =>
    interpolate(lookup(dictionaries[locale], key) ?? lookup(dictionaries.en, key) ?? key, params);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}
