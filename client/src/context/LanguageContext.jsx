import { createContext, useContext, useState, useCallback } from 'react'
import zh from '../locales/zh'
import en from '../locales/en'

const DICTS = { zh, en }
const LanguageContext = createContext(null)

export function LanguageProvider({ children }) {
  const [lang, setLang] = useState(() => localStorage.getItem('lang') || 'zh')

  const toggle = useCallback(() => {
    setLang(prev => {
      const next = prev === 'zh' ? 'en' : 'zh'
      localStorage.setItem('lang', next)
      return next
    })
  }, [])

  // t('nav.home') → looks up DICTS[lang].nav.home
  // t('errors.<English>', { defaultValue }) → returns defaultValue when the
  // key is missing from the dict (used for backend error passthrough on en
  // and for any English string the zh dict doesn't yet cover).
  const t = useCallback((key, opts) => {
    const parts = key.split('.')
    let val = DICTS[lang]
    for (const p of parts) val = val?.[p]
    if (val !== undefined && val !== null) return val
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'defaultValue')) {
      return opts.defaultValue
    }
    return key
  }, [lang])

  return (
    <LanguageContext.Provider value={{ lang, toggle, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

// Fallback for components rendered outside a LanguageProvider (notably in
// component-level unit tests that don't wrap a provider). Returns a `t` that
// resolves keys against the default zh dict, so tests still see real strings
// instead of raw keys, and components don't crash if accidentally mounted bare.
const FALLBACK_LANG = {
  lang: 'zh',
  toggle: () => {},
  t: (key, opts) => {
    const parts = String(key).split('.')
    let val = DICTS.zh
    for (const p of parts) val = val?.[p]
    if (val !== undefined && val !== null) return val
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'defaultValue')) {
      return opts.defaultValue
    }
    return key
  },
}

export const useLang = () => useContext(LanguageContext) ?? FALLBACK_LANG
