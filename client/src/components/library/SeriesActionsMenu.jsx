// @ts-check
import { useEffect, useRef, useState } from 'react';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

const HUE = PLAYER_HUE.stream;

const s = {
  wrap: {
    position: 'relative',
  },
  btn: {
    ...mono,
    padding: '6px 12px',
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.55)`,
    borderRadius: 3,
    color: `oklch(80% 0.13 ${HUE})`,
    cursor: 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
  menu: {
    position: 'absolute',
    top: 32,
    right: 0,
    minWidth: 180,
    background: `oklch(12% 0.03 ${HUE} / 0.96)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 3,
    boxShadow: '0 4px 16px oklch(2% 0 0 / 0.5)',
    padding: '4px 0',
    zIndex: 50,
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
  },
  item: {
    ...mono,
    display: 'block',
    width: '100%',
    padding: '8px 14px',
    background: 'transparent',
    border: 'none',
    color: 'rgba(235,235,245,0.92)',
    textAlign: 'left',
    fontSize: 11,
    cursor: 'pointer',
    letterSpacing: '0.05em',
  },
};

/**
 * SeriesActionsMenu — §5.6 详情页主动作菜单。详情页是移动端唯一管理入口,
 * 这个菜单收敛 [合并到…] / [拆分此系列] / [重新匹配] 三项写库动作,可选挂载
 * [操作日志] 入口(§5.6 v3,只在详情页提供)。
 *
 * 自管开关与 click-outside,父组件只挂回调。
 *
 * @param {{
 *   onMerge: () => void,
 *   onSplit: () => void,
 *   onRematch: () => void,
 *   onOpsLog?: () => void,
 *   label?: string,
 * }} props
 */
export default function SeriesActionsMenu({ onMerge, onSplit, onRematch, onOpsLog, label = 'Actions ▾' }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(/** @type {HTMLDivElement|null} */ (null));

  useEffect(() => {
    if (!open) return undefined;
    function handleOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  function fire(fn) {
    setOpen(false);
    fn();
  }

  return (
    <div style={s.wrap} ref={wrapRef}>
      <button
        type="button"
        data-testid="actions-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={s.btn}
      >
        {label}
      </button>
      {open && (
        <div role="menu" data-testid="actions-menu" style={s.menu}>
          <button
            type="button"
            role="menuitem"
            data-testid="action-merge"
            style={s.item}
            onClick={() => fire(onMerge)}
          >
            合并到其他系列…
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="action-split"
            style={s.item}
            onClick={() => fire(onSplit)}
          >
            拆分此系列…
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="action-rematch"
            style={s.item}
            onClick={() => fire(onRematch)}
          >
            重新匹配…
          </button>
          {onOpsLog && (
            <button
              type="button"
              role="menuitem"
              data-testid="action-opslog"
              style={s.item}
              onClick={() => fire(onOpsLog)}
            >
              操作日志
            </button>
          )}
        </div>
      )}
    </div>
  );
}
