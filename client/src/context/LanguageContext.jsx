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
  const t = useCallback((key) => {
    const parts = key.split('.')
    let val = DICTS[lang]
    for (const p of parts) val = val?.[p]
    return val ?? key
  }, [lang])

  return (
    <LanguageContext.Provider value={{ lang, toggle, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export const useLang = () => useContext(LanguageContext)
