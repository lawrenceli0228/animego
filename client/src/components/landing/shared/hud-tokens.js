/**
 * landing/shared/hud-tokens.js — re-export of the canonical HUD tokens.
 *
 * The HUD vocabulary was promoted to `client/src/components/shared/hud-tokens`
 * so the player surface (and any future chrome) can consume the same tokens
 * without depending on the `landing/` namespace. Existing landing imports of
 * `./shared/hud-tokens` continue to work via this barrel re-export.
 */

export {
  HUD_VIEWPORT,
  HUE,
  PLAYER_HUE,
  L,
  C,
  oklchToken,
  mono,
  label,
  useCountUp,
} from '../../shared/hud-tokens'
