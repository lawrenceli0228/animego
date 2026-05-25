"use client";

// Client-side i18n provider for the ported Library + Player surfaces
// (P6). Mirrors client/src/context/LanguageContext.jsx 1:1 so the
// ported components can `import { useLang } from "@/lib/lang-client"`
// without rewriting their hundreds of `t('foo.bar')` call sites.
//
// next-app already has @/lib/i18n.ts for RSC-side translation
// (getDict + tFromDict) — that one is server-only. This file is the
// client counterpart, with a Provider that should wrap any subtree
// containing the legacy ports.

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
// locales/*-spa.js are unchecked JS dicts copied from the legacy SPA.
// Keeping them in .js form avoids a 638-line type rewrite; tsc resolves
// them fine because tsconfig allows JS module resolution.
import zh from "@/locales/zh-spa.js";
import en from "@/locales/en-spa.js";

type Dict = Record<string, unknown>;
type Lang = "zh" | "en";

const DICTS: Record<Lang, Dict> = { zh, en };

interface LangContextValue {
  lang: Lang;
  toggle: () => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}

const LanguageContext = createContext<LangContextValue | null>(null);

function resolve(
  dict: Dict,
  key: string,
  opts?: { defaultValue?: string },
): string {
  const parts = key.split(".");
  let val: unknown = dict;
  for (const p of parts) {
    if (val && typeof val === "object" && p in (val as Record<string, unknown>)) {
      val = (val as Record<string, unknown>)[p];
    } else {
      val = undefined;
      break;
    }
  }
  if (val !== undefined && val !== null) return String(val);
  if (opts && Object.prototype.hasOwnProperty.call(opts, "defaultValue")) {
    return opts.defaultValue ?? key;
  }
  return key;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    if (typeof window === "undefined") return "zh";
    const stored = localStorage.getItem("lang");
    return stored === "en" ? "en" : "zh";
  });

  const toggle = useCallback(() => {
    setLang((prev) => {
      const next: Lang = prev === "zh" ? "en" : "zh";
      if (typeof window !== "undefined") {
        localStorage.setItem("lang", next);
      }
      return next;
    });
  }, []);

  const t = useCallback(
    (key: string, opts?: { defaultValue?: string }) =>
      resolve(DICTS[lang], key, opts),
    [lang],
  );

  return (
    <LanguageContext.Provider value={{ lang, toggle, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

// Fallback dict resolves against zh — keeps tests + accidental
// bare-mounted components from crashing or showing raw keys.
const FALLBACK: LangContextValue = {
  lang: "zh",
  toggle: () => {},
  t: (key, opts) => resolve(DICTS.zh, key, opts),
};

export const useLang = (): LangContextValue =>
  useContext(LanguageContext) ?? FALLBACK;
