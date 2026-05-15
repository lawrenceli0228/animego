// @ts-check
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

const HUE = PLAYER_HUE.local;

const s = {
  wrap: { position: 'relative', display: 'inline-block' },
  trigger: {
    ...mono,
    width: 28,
    height: 28,
    background: 'transparent',
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 4,
    color: 'rgba(235,235,245,0.85)',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    position: 'relative',
    transition: 'background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out',
  },
  triggerOpen: {
    background: `oklch(62% 0.17 ${HUE} / 0.18)`,
    // Use the same `border` shorthand as `trigger.border` so the inline-style
    // diff doesn't end up `{border, borderColor}` mixed on rerender.
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.65)`,
    color: `oklch(72% 0.15 ${HUE})`,
  },
  bracket: {
    position: 'absolute',
    width: 5,
    height: 5,
    pointerEvents: 'none',
    opacity: 0.55,
  },
  bracketTl: { top: 2, left: 2, borderTop: '1px solid currentColor', borderLeft: '1px solid currentColor' },
  bracketTr: { top: 2, right: 2, borderTop: '1px solid currentColor', borderRight: '1px solid currentColor' },
  bracketBl: { bottom: 2, left: 2, borderBottom: '1px solid currentColor', borderLeft: '1px solid currentColor' },
  bracketBr: { bottom: 2, right: 2, borderBottom: '1px solid currentColor', borderRight: '1px solid currentColor' },

  popover: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    minWidth: 200,
    background: `oklch(12% 0.03 ${HUE} / 0.95)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 4,
    boxShadow: '0 8px 28px oklch(2% 0 0 / 0.55)',
    padding: '4px 0',
    zIndex: 100,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    transformOrigin: 'top right',
  },
  item: {
    ...mono,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '8px 14px 8px 16px',
    background: 'transparent',
    border: 'none',
    color: 'rgba(235,235,245,0.92)',
    textAlign: 'left',
    fontSize: 11,
    cursor: 'pointer',
    letterSpacing: '0.06em',
    position: 'relative',
  },
  itemDisabled: {
    color: 'rgba(235,235,245,0.35)',
    cursor: 'not-allowed',
  },
  itemHover: {
    background: `oklch(62% 0.17 ${HUE} / 0.12)`,
  },
  itemDanger: { color: 'oklch(72% 0.18 25)' },
  itemDangerHover: { background: 'oklch(60% 0.20 25 / 0.12)' },
  divider: {
    height: 1,
    background: `oklch(46% 0.06 ${HUE} / 0.30)`,
    margin: '4px 8px',
  },
  rail: {
    position: 'absolute',
    left: 0,
    top: 4,
    bottom: 4,
    width: 2,
    background: `oklch(62% 0.17 ${HUE})`,
    opacity: 0,
    transition: 'opacity 120ms',
    borderRadius: 2,
  },
  railDanger: { background: 'oklch(72% 0.18 25)' },
  itemIcon: {
    width: 12,
    color: 'rgba(235,235,245,0.45)',
    fontSize: 12,
    lineHeight: 1,
    flexShrink: 0,
    textAlign: 'center',
  },
};

/**
 * @typedef {Object} OverflowItem
 * @property {string} id
 * @property {string} label
 * @property {() => void} onClick
 * @property {boolean} [disabled]
 * @property {boolean} [danger]
 * @property {boolean} [divideBefore]
 * @property {string} [icon]
 * @property {string} [testId]
 */

/**
 * HudOverflowMenu — `⋯` icon trigger with HUD-styled popover dropdown.
 *
 * §5.x library redesign: the header right-side collapses to
 *   [+ Add Folder primary CTA] + [⋯ overflow]
 * with all maintenance verbs (dedupe / refresh metadata / refresh availability
 * / reset library) living in this popover. The reset action is danger-styled
 * and divider-isolated at the bottom (GitHub "danger zone" pattern), so it
 * never sits next to the primary CTA where mis-clicks cost data.
 *
 * Behavior: closes on outside click and Esc. Up/Down arrows navigate enabled
 * items; Enter/Space activates. The first enabled item receives focus when
 * the menu opens. Returning the trigger to focused state on Esc preserves
 * keyboard flow.
 *
 * @param {{
 *   items: OverflowItem[],
 *   testId?: string,
 *   ariaLabel?: string,
 * }} props
 */
export default function HudOverflowMenu({
  items,
  testId = 'overflow-menu',
  ariaLabel = '更多操作',
}) {
  const [open, setOpen] = useState(false);
  const [hoverId, setHoverId] = useState(/** @type {string|null} */ (null));
  const wrapRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const triggerRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const itemRefs = useRef(/** @type {Map<string, HTMLButtonElement>} */ (new Map()));
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!open) return undefined;

    function onPointer(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const enabled = items.filter((it) => !it.disabled);
        if (enabled.length === 0) return;
        const active = document.activeElement;
        const idx = enabled.findIndex((it) => itemRefs.current.get(it.id) === active);
        const next = e.key === 'ArrowDown'
          ? (idx + 1) % enabled.length
          : (idx - 1 + enabled.length) % enabled.length;
        itemRefs.current.get(enabled[next].id)?.focus();
      }
    }

    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);

    // Focus first enabled item shortly after the popover mounts so the
    // arrow-key cycle has a known starting point.
    const firstEnabled = items.find((it) => !it.disabled);
    if (firstEnabled) {
      // Defer one frame so the ref map is populated post-mount.
      requestAnimationFrame(() => {
        itemRefs.current.get(firstEnabled.id)?.focus();
      });
    }

    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, items]);

  function fire(item) {
    if (item.disabled) return;
    setOpen(false);
    setHoverId(null);
    item.onClick();
  }

  function setItemRef(id, el) {
    if (el) itemRefs.current.set(id, el);
    else itemRefs.current.delete(id);
  }

  return (
    <div ref={wrapRef} style={s.wrap} data-testid={testId}>
      <button
        ref={triggerRef}
        type="button"
        data-testid={`${testId}-trigger`}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ ...s.trigger, ...(open ? s.triggerOpen : null) }}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden style={{ position: 'relative', top: -1 }}>⋯</span>
        <span style={{ ...s.bracket, ...s.bracketTl }} aria-hidden />
        <span style={{ ...s.bracket, ...s.bracketTr }} aria-hidden />
        <span style={{ ...s.bracket, ...s.bracketBl }} aria-hidden />
        <span style={{ ...s.bracket, ...s.bracketBr }} aria-hidden />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            data-testid={`${testId}-popover`}
            style={s.popover}
            initial={reduced ? false : { opacity: 0, y: -6, scale: 0.97 }}
            animate={reduced ? undefined : { opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? undefined : { opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          >
            {items.map((item, i) => {
              const showDivider = item.divideBefore && i > 0;
              const hovered = hoverId === item.id;
              const railStyle = {
                ...s.rail,
                ...(item.danger ? s.railDanger : null),
                opacity: hovered && !item.disabled ? 1 : 0,
              };
              const itemStyle = {
                ...s.item,
                ...(item.danger ? s.itemDanger : null),
                ...(item.disabled ? s.itemDisabled : null),
                ...(hovered && !item.disabled
                  ? (item.danger ? s.itemDangerHover : s.itemHover)
                  : null),
              };
              return (
                <div key={item.id}>
                  {showDivider && <div style={s.divider} aria-hidden />}
                  <button
                    ref={(el) => setItemRef(item.id, el)}
                    type="button"
                    role="menuitem"
                    data-testid={item.testId || `${testId}-item-${item.id}`}
                    disabled={item.disabled}
                    style={itemStyle}
                    onMouseEnter={() => setHoverId(item.id)}
                    onMouseLeave={() => setHoverId(null)}
                    onFocus={() => setHoverId(item.id)}
                    onBlur={() => setHoverId(null)}
                    onClick={() => fire(item)}
                  >
                    <span style={railStyle} aria-hidden />
                    {item.icon && <span style={s.itemIcon} aria-hidden>{item.icon}</span>}
                    <span>{item.label}</span>
                  </button>
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
