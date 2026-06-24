import { createContext, useContext, type ReactNode } from "react";
import { translations, type UiLang } from "./i18n";

type Vars = Record<string, string | number>;

function interpolate(str: string, vars?: Vars): string {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

interface I18nValue {
  lang: UiLang;
  t: (key: string, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue>({
  lang: "en",
  t: (key) => key,
});

export function I18nProvider({ lang, children }: { lang: UiLang; children: ReactNode }) {
  const dict = translations[lang] ?? translations.en;
  const t = (key: string, vars?: Vars): string => {
    const str = dict[key] ?? translations.en[key] ?? key;
    return interpolate(str, vars);
  };
  return <I18nContext.Provider value={{ lang, t }}>{children}</I18nContext.Provider>;
}

export function useT() {
  return useContext(I18nContext).t;
}

export function useLang() {
  return useContext(I18nContext).lang;
}
