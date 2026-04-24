/**
 * shared/hud.jsx — landing section HUD primitives (components only).
 * Non-component exports (tokens, hooks) live in ./hud-tokens so react-refresh
 * can fast-update these components on edit.
 */

import { motion as Motion, useReducedMotion } from 'motion/react'
import { HUD_VIEWPORT } from './hud-tokens'

/* ─── SectionNum — top-right "§0X" chapter marker ────────────────────── */

const sectionNumStyle = {
  position: 'absolute',
  top: 28,
  right: 32,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  letterSpacing: '0.14em',
  color: 'rgba(235,235,245,0.30)',
  textTransform: 'uppercase',
  zIndex: 2,
}

export function SectionNum({ n, style }) {
  return (
    <span style={{ ...sectionNumStyle, ...style }} aria-hidden>
      §{n}
    </span>
  )
}

/* ─── SectionHeader — eyebrow + title + sub ──────────────────────────── */

const headerStyles = {
  wrap: { maxWidth: 720, marginBottom: 64, position: 'relative', zIndex: 1 },
  eyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: '0.12em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 'clamp(2rem, 1rem + 3vw, 3.5rem)',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
    marginBottom: 20,
  },
  sub: {
    fontSize: 16,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.6,
    maxWidth: 560,
  },
}

export function SectionHeader({ eyebrow, title, sub, titleId, style }) {
  return (
    <header style={{ ...headerStyles.wrap, ...style }}>
      {eyebrow && <div style={headerStyles.eyebrow}>{eyebrow}</div>}
      {title && (
        <h2 id={titleId} style={headerStyles.title}>
          {title}
        </h2>
      )}
      {sub && <p style={headerStyles.sub}>{sub}</p>}
    </header>
  )
}

/* ─── ChapterBar — OKLCH column, scaleY entrance on inView ──────────── */

function chapterBarStyle(hue, height) {
  return {
    position: 'absolute',
    top: 28,
    left: 28,
    width: 3,
    height,
    background: `oklch(62% 0.19 ${hue})`,
    borderRadius: 2,
    boxShadow: `0 0 24px oklch(62% 0.19 ${hue} / 0.55)`,
    transformOrigin: 'top',
  }
}

export function ChapterBar({ hue = 210, height = 52, delay = 0, style, className }) {
  const reduced = useReducedMotion()
  return (
    <Motion.span
      className={className}
      style={{ ...chapterBarStyle(hue, height), ...style }}
      initial={reduced ? false : { scaleY: 0 }}
      whileInView={reduced ? undefined : { scaleY: 1 }}
      viewport={HUD_VIEWPORT}
      transition={{ duration: 0.5, delay, ease: [0.16, 1, 0.3, 1] }}
      aria-hidden
    />
  )
}

/* ─── CornerBrackets — 4 HUD L brackets (absolute; parent must be relative) ── */

export function CornerBrackets({ inset = 6, size = 8, opacity = 0.28 }) {
  const stroke = `rgba(235,235,245,${opacity})`
  const corner = (pos) => {
    const style = { position: 'absolute', width: size, height: size, pointerEvents: 'none' }
    if (pos === 'tl') { style.top = inset; style.left = inset }
    if (pos === 'tr') { style.top = inset; style.right = inset; style.transform = 'scaleX(-1)' }
    if (pos === 'bl') { style.bottom = inset; style.left = inset; style.transform = 'scaleY(-1)' }
    if (pos === 'br') { style.bottom = inset; style.right = inset; style.transform = 'scale(-1,-1)' }
    return (
      <svg key={pos} style={style} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <path d={`M 0 ${size} L 0 0 L ${size} 0`} stroke={stroke} strokeWidth="1" fill="none" />
      </svg>
    )
  }
  return <>{['tl', 'tr', 'bl', 'br'].map(corner)}</>
}
