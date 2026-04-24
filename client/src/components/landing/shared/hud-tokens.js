/**
 * shared/hud-tokens.js — non-component exports for landing HUD vocabulary.
 * Kept separate from hud.jsx so react-refresh can fast-update components.
 */

import { useEffect, useRef, useState } from 'react'
import { animate as animateValue, useInView, useReducedMotion } from 'motion/react'

/**
 * Shared viewport margin for useInView-driven entrances across §01–§09.
 * Change once here, all sections follow.
 */
export const HUD_VIEWPORT = { once: true, margin: '-15% 0px' }

/** Mono text token (JetBrains Mono + tabular-nums). HUD chrome only — not body. */
export const mono = {
  fontFamily: "'JetBrains Mono', monospace",
  letterSpacing: '0.06em',
  fontVariantNumeric: 'tabular-nums',
}

/** Small uppercase mono label. HUD chrome only — do not use for body copy (fontSize 10 is a11y-borderline). */
export const label = {
  ...mono,
  fontSize: 10,
  color: 'rgba(235,235,245,0.45)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
}

/**
 * useCountUp — scroll-triggered numeric count-up via motion.animate.
 * Returns [ref, displayValue]. Attach ref to the element whose inView triggers
 * the count; read displayValue as the rendered number.
 */
export function useCountUp(target, { duration = 1.4, delay = 0, format = (v) => Math.round(v) } = {}) {
  const ref = useRef(null)
  const inView = useInView(ref, HUD_VIEWPORT)
  const reduced = useReducedMotion()
  const [value, setValue] = useState(reduced ? target : 0)

  useEffect(() => {
    if (!inView) return
    if (reduced) { setValue(target); return }
    const controls = animateValue(0, target, {
      duration,
      delay,
      ease: [0.33, 1, 0.68, 1],
      onUpdate: (v) => setValue(v),
    })
    return () => controls.stop()
  }, [inView, reduced, target, duration, delay])

  return [ref, format(value)]
}
