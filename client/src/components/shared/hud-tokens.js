/**
 * shared/hud-tokens.js — non-component HUD tokens (canonical location).
 * Originally lived under `landing/shared/`; promoted to a top-level shared module
 * so player chrome (and any future surface) can consume the same vocabulary
 * without depending on the `landing/` namespace. The file under
 * `landing/shared/hud-tokens.js` now re-exports from here.
 *
 * Kept separate from hud.jsx so react-refresh can fast-update components.
 */

import { useEffect, useRef, useState } from 'react'
import { animate as animateValue, useInView, useReducedMotion } from 'motion/react'

/**
 * Shared viewport margin for useInView-driven entrances across §01–§09 + player chrome.
 * Change once here, all surfaces follow.
 */
export const HUD_VIEWPORT = { once: true, margin: '-15% 0px' }

/**
 * Section hue registry. Each landing chapter owns one primary hue and uses the
 * L/C tier matrix below to derive trench/rail/primary/readout/hot/flash tones.
 * §04 (bento) and §05 (poster) are multi-hue showcases and source their hues
 * from per-item data, not this registry.
 */
export const HUE = {
  s01: 330, // Magenta Proof — hero identity
  s02: 210, // Data Blue — stats
  s03: 40,  // Amber Archive — data-sources tribute
  s06: 260, // Violet Caliper — differentiator
  s07: 195, // LIVE Cyan — danmaku
  s08: 70,  // Chartreuse Clear — FAQ
  s09: 40,  // Ember — final CTA
}

/**
 * Player chrome hues — same OKLCH palette, but assigned semantically per
 * player-surface concern. All ingest/stream/status surfaces sit in the iOS Blue
 * family (per DESIGN.md `--accent` #0a84ff); only `live` breaks out for done-state
 * green so success states stay distinguishable.
 */
export const PLAYER_HUE = {
  stream: 210,    // header/stream identity
  ingest: 210,    // DropZone, danmaku picker — aligned to stream blue per DESIGN.md
  status: 200,    // MatchProgress connector bar
  live: 140,      // active/done states (greens)
  local: 210,     // §5.10 LOCAL family — same as stream, named for library scope
}

/**
 * Library-scope hue registry (§5.10). Library surfaces (LibraryPage, LocalSeriesPage,
 * SeriesCard) reuse PLAYER_HUE.local for the LOCAL family; this registry only holds
 * the off-family hues that don't fit `local` — currently `unclassified` for amber
 * borders on the unmatched-files dropzone.
 */
export const LIBRARY_HUE = {
  unclassified: 40, // amber — §5.5 未归类 dropzone border
}

/** §5.10 — `⬡` U+2B22 LOCAL glyph, used by SeriesCard / UndoToast / LocalSeriesPage hero. */
export const LOCAL_HEX_GLYPH = '⬡'

/** §5.10 — `--local-badge-color`. LOCAL pill text + border (rgba alpha applied at site). */
export const LOCAL_BADGE_COLOR = '#5ac8fa'

/** §5.10 — `--progress-fill`. Solid iOS Blue for filled portions of progress bars. */
export const PROGRESS_FILL = '#0a84ff'

/** §5.10 — `--progress-track`. OKLCH track tone for non-poster progress contexts. */
export const PROGRESS_TRACK = `oklch(62% 0.17 ${PLAYER_HUE.local} / 0.25)`

/**
 * L tier (lightness %) — layered depth, dark→light.
 *   trench  — deep background wash
 *   rail    — divider / low-signal chrome
 *   primary — main accent bar, glyph, button border
 *   readout — mono label, small caption
 *   hot     — :hover / active / open-state lift
 *   flash   — count-up flash peak, short-lived emphasis
 */
export const L = { trench: 14, rail: 46, primary: 62, readout: 72, hot: 82, flash: 92 }

/**
 * C tier (chroma) — gamut-safe defaults. §07 (hue 195) and §08 (hue 70) sit at
 * low-chroma ends of sRGB; their `primary` tier overrides L upward to recover
 * vibrancy without clipping. Tune per-section when the primary hue doesn't fit
 * the default L=62 C=0.17 cell.
 */
export const C = { trench: 0.04, rail: 0.06, primary: 0.17, readout: 0.14, hot: 0.16, flash: 0.08 }

/**
 * oklchToken(layer, hue, alpha?) — stringifier for the L/C matrix above.
 * Usage: oklchToken('primary', HUE.s01)  →  'oklch(62% 0.17 330)'
 *        oklchToken('primary', HUE.s01, 0.45) → 'oklch(62% 0.17 330 / 0.45)'
 */
export function oklchToken(layer, hue, alpha) {
  const l = L[layer]
  const c = C[layer]
  if (alpha == null) return `oklch(${l}% ${c} ${hue})`
  return `oklch(${l}% ${c} ${hue} / ${alpha})`
}

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
