// @ts-check
import { useCallback, useEffect, useRef, useState } from 'react';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';
import { useLang } from '../../context/LanguageContext';

const HUE = PLAYER_HUE.local;

const s = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 8 },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    padding: '0 4px',
    gap: 12,
  },
  label: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.45)',
    letterSpacing: '0.15em',
    textTransform: 'uppercase',
  },
  count: {
    ...mono,
    fontSize: 9,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.10em',
  },
  scrollWrap: { position: 'relative' },
  scroller: {
    display: 'flex',
    gap: 12,
    overflowX: 'auto',
    paddingBottom: 4,
    paddingLeft: 4,
    paddingRight: 4,
    scrollSnapType: 'x mandatory',
    scrollBehavior: 'smooth',
    WebkitMaskImage: 'linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)',
    maskImage: 'linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)',
    scrollbarWidth: 'none',
  },
  chevron: (side, visible) => ({
    position: 'absolute',
    top: '50%',
    [side]: 6,
    transform: 'translateY(-50%)',
    width: 32,
    height: 32,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 4,
    background: `oklch(12% 0.03 ${HUE} / 0.85)`,
    color: 'rgba(235,235,245,0.85)',
    cursor: 'pointer',
    fontSize: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    opacity: visible ? 1 : 0,
    pointerEvents: visible ? 'auto' : 'none',
    transition: 'opacity 150ms ease-out, background-color 150ms ease-out',
    zIndex: 2,
    padding: 0,
    fontFamily: 'inherit',
    lineHeight: 1,
  }),
};

/**
 * ScrollRow — horizontal snap-scroll row shell with optional label and
 * left/right chevron buttons. Hides scrollbar; left/right edges fade via
 * CSS mask. Chevrons appear on hover when there's overflow to scroll.
 *
 * Used by §5.x library rows (Recently Played, New Additions). Generic enough
 * to host any flex children — typically <SeriesCard compact /> tiles.
 *
 * @param {{
 *   label?: string,
 *   count?: number,
 *   children: React.ReactNode,
 *   testId?: string,
 *   scrollAmount?: number,
 * }} props
 */
export default function ScrollRow({
  label,
  count,
  children,
  testId = 'scroll-row',
  scrollAmount = 320,
}) {
  const { t } = useLang();
  const scrollerRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const [hovering, setHovering] = useState(false);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft < max - 4);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = scrollerRef.current;
    if (!el) return undefined;
    const onScroll = () => updateScrollState();
    el.addEventListener('scroll', onScroll, { passive: true });
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(updateScrollState);
      ro.observe(el);
    }
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [updateScrollState]);

  return (
    <div style={s.wrap} data-testid={testId}>
      {label && (
        <div style={s.header}>
          <span style={s.label}>{label}</span>
          {typeof count === 'number' && <span style={s.count} data-testid={`${testId}-count`}>{count}</span>}
        </div>
      )}
      <div
        style={s.scrollWrap}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <div ref={scrollerRef} style={s.scroller} data-testid={`${testId}-scroller`}>
          {children}
        </div>
        <button
          type="button"
          aria-label={t('library.row.scrollLeft')}
          data-testid={`${testId}-chev-left`}
          style={s.chevron('left', hovering && canLeft)}
          onClick={() => scrollerRef.current?.scrollBy({ left: -scrollAmount, behavior: 'smooth' })}
        >
          ‹
        </button>
        <button
          type="button"
          aria-label={t('library.row.scrollRight')}
          data-testid={`${testId}-chev-right`}
          style={s.chevron('right', hovering && canRight)}
          onClick={() => scrollerRef.current?.scrollBy({ left: scrollAmount, behavior: 'smooth' })}
        >
          ›
        </button>
      </div>
      <style>{`[data-testid="${testId}-scroller"]::-webkit-scrollbar { display: none; height: 0; }`}</style>
    </div>
  );
}
