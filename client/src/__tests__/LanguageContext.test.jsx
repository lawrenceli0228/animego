import { render, screen } from '@testing-library/react'
import { LanguageProvider, useLang } from '../context/LanguageContext'

function Probe({ k }) {
  const { t } = useLang()
  return <span data-testid="out">{t(k)}</span>
}

function renderWithLang(k) {
  render(
    <LanguageProvider>
      <Probe k={k} />
    </LanguageProvider>
  )
  return screen.getByTestId('out')
}

describe('LanguageContext', () => {
  beforeEach(() => localStorage.clear())
  it('returns key string for a completely missing key', () => {
    const el = renderWithLang('some.missing.key')
    expect(el.textContent).toBe('some.missing.key')
  })

  it('returns partial key when intermediate node is missing', () => {
    const el = renderWithLang('nonexistent.deep.path')
    expect(el.textContent).toBe('nonexistent.deep.path')
  })

  it('returns known translation for existing key (zh default)', () => {
    const el = renderWithLang('nav.home')
    expect(el.textContent).toBe('首页')
  })

  it('does not crash on empty string key', () => {
    expect(() => renderWithLang('')).not.toThrow()
  })
})
