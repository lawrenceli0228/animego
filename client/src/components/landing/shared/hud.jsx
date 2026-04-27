/**
 * landing/shared/hud.jsx — re-export of the canonical HUD primitives.
 *
 * The four HUD primitives (SectionNum, SectionHeader, ChapterBar,
 * CornerBrackets) were promoted to `client/src/components/shared/hud` so the
 * player surface (and any future chrome) can consume them without depending on
 * the `landing/` namespace. Existing landing imports of `./shared/hud`
 * continue to work via this barrel re-export.
 */

export { SectionNum, SectionHeader, ChapterBar, CornerBrackets } from '../../shared/hud'
