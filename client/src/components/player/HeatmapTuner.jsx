/**
 * HeatmapTuner — dev-only tooling panel for tweaking the artplayer-plugin-danmuku
 * heatmap visuals at runtime. Pure tooling: when not mounted, production behavior
 * is unchanged.
 *
 * Group A (CSS) writes straight to CSS custom properties on documentElement.
 * Group B (geometry) computes the path locally and overwrites the plugin's
 * <path d="..."/> imperatively, so all knobs apply LIVE without re-init.
 * Group B values persist to localStorage under 'animego.heatmapConfig' so
 * VideoPlayer can pre-seed the plugin at next page load.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { mono } from '../shared/hud-tokens';
import { applyHeatmapPath } from '../../lib/heatmapPath';

const STORAGE_KEY = 'animego.heatmapConfig';

// Defaults from a design review against DESIGN.md + plugin source audit:
// iOS Teal (read-only/info), slim 14px band, scaleY 1.6 stays clear of the
// viewBox top so peaks don't clip into flat-topped puddles. Group B values
// roughly match plugin stock (sampling/scale/smoothing) so peaks emerge from
// the data rather than from minHeight raising the whole baseline.
const GROUP_A_DEFAULTS = {
  bandHeight: 2,
  scaleY: 17.35,
  fillColor: '#ffffff',
  fillOpacity: 0.4,
  alwaysVisible: true,
};

const GROUP_B_DEFAULTS = {
  sampling: 7,
  smoothing: 0.35,
  flattening: 0.05,
  scale: 0.011,
  minHeight: 4,
};

const GROUP_A_RANGES = {
  bandHeight: { min: 0, max: 80, step: 1 },
  scaleY: { min: 0.2, max: 30, step: 0.05 },
  fillOpacity: { min: 0.05, max: 1, step: 0.05 },
};

const GROUP_B_RANGES = {
  sampling: { min: 1, max: 30, step: 1 },
  smoothing: { min: 0, max: 1, step: 0.05 },
  flattening: { min: 0, max: 1, step: 0.05 },
  scale: { min: 0.001, max: 0.05, step: 0.01 },
  minHeight: { min: 0, max: 20, step: 1 },
};

function loadGroupB() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...GROUP_B_DEFAULTS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...GROUP_B_DEFAULTS };
    return { ...GROUP_B_DEFAULTS, ...parsed };
  } catch {
    return { ...GROUP_B_DEFAULTS };
  }
}

function persistGroupB(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // ignore
  }
}

function applyGroupA(values) {
  const root = document.documentElement;
  root.style.setProperty('--heatmap-h', `${values.bandHeight}px`);
  root.style.setProperty('--heatmap-scale-y', String(values.scaleY));
  root.style.setProperty('--heatmap-fill', values.fillColor);
  root.style.setProperty('--heatmap-opacity', String(values.fillOpacity));
  const player = document.querySelector('.art-video-player');
  if (player) {
    player.setAttribute('data-heatmap-always', values.alwaysVisible ? '1' : '0');
  }
}

let warnedReason = null;
function warnOnce(reason) {
  if (warnedReason === reason) return;
  warnedReason = reason;
  // eslint-disable-next-line no-console
  console.warn(`[HeatmapTuner] live update unavailable: ${reason}`);
}

function applyGroupBLive(values) {
  const art = typeof window !== 'undefined' ? window.__artInstance : null;
  if (!art) {
    warnOnce('no artplayer instance on window.__artInstance');
    return { ok: false, reason: 'no art instance' };
  }
  const result = applyHeatmapPath(art, values);
  if (!result.ok) warnOnce(result.reason);
  return result;
}

const PANEL_BG = '#1c1c1e';
const PANEL_BORDER = '#38383a';
const TEXT_PRIMARY = '#ffffff';
const TEXT_DIM = 'rgba(235,235,245,0.55)';

const s = {
  panel: {
    position: 'fixed',
    top: 16,
    right: 16,
    width: 280,
    maxHeight: 'calc(100vh - 32px)',
    overflowY: 'auto',
    background: PANEL_BG,
    border: `1px solid ${PANEL_BORDER}`,
    borderRadius: 12,
    padding: 0,
    zIndex: 9999,
    boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
    color: TEXT_PRIMARY,
  },
  header: {
    ...mono,
    fontSize: 11,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    padding: '12px 14px',
    borderBottom: `1px solid ${PANEL_BORDER}`,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    cursor: 'pointer',
    userSelect: 'none',
  },
  body: { padding: '10px 14px 14px' },
  groupTitle: {
    ...mono,
    fontSize: 10,
    color: TEXT_DIM,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    margin: '12px 0 6px',
  },
  row: { marginBottom: 10 },
  rowHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  label: { ...mono, fontSize: 11, color: TEXT_PRIMARY, letterSpacing: '0.06em' },
  value: { ...mono, fontSize: 11, color: TEXT_DIM },
  slider: { width: '100%', accentColor: '#0a84ff' },
  colorInput: {
    width: 36,
    height: 24,
    background: 'transparent',
    border: `1px solid ${PANEL_BORDER}`,
    borderRadius: 4,
    cursor: 'pointer',
    padding: 0,
  },
  toggleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  buttonRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 12,
    paddingTop: 12,
    borderTop: `1px solid ${PANEL_BORDER}`,
  },
  btn: {
    ...mono,
    fontSize: 11,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    padding: '8px 12px',
    background: 'transparent',
    border: `1px solid ${PANEL_BORDER}`,
    borderRadius: 6,
    color: TEXT_PRIMARY,
    cursor: 'pointer',
  },
  btnPrimary: {
    background: 'rgba(10,132,255,0.18)',
    // Match `btn.border` shorthand shape so React doesn't end up diffing
    // `{border, borderColor}` mixed on rerender.
    border: '1px solid rgba(10,132,255,0.45)',
  },
  btnConfirm: { color: '#30d158', fontSize: 10 },
};

function formatValue(key, val) {
  if (key === 'bandHeight') return `${val}px`;
  if (key === 'sampling' || key === 'minHeight') return String(val);
  return Number(val).toFixed(3);
}

function Slider({ label, valueKey, value, range, onChange }) {
  return (
    <div style={s.row}>
      <div style={s.rowHeader}>
        <span style={s.label}>{label}</span>
        <span style={s.value}>{formatValue(valueKey, value)}</span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={s.slider}
      />
    </div>
  );
}

export default function HeatmapTuner() {
  const [collapsed, setCollapsed] = useState(false);
  const [groupA, setGroupA] = useState(() => ({ ...GROUP_A_DEFAULTS }));
  const [groupB, setGroupB] = useState(() => loadGroupB());
  const [copied, setCopied] = useState(false);
  const [diag, setDiag] = useState(null);
  const didMountRef = useRef(false);

  useEffect(() => {
    applyGroupA(groupA);
  }, [groupA]);

  // While the panel is mounted, force the heatmap to stay visible regardless
  // of `.art-hover` so moving the mouse onto this panel doesn't hide what
  // we're tuning.
  useEffect(() => {
    const player = document.querySelector('.art-video-player');
    if (!player) return undefined;
    player.setAttribute('data-heatmap-tuner-active', '1');
    return () => player.removeAttribute('data-heatmap-tuner-active');
  }, []);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    persistGroupB(groupB);
    setDiag(applyGroupBLive(groupB));
  }, [groupB]);

  const updateA = useCallback((key, val) => {
    setGroupA((prev) => ({ ...prev, [key]: val }));
  }, []);
  const updateB = useCallback((key, val) => {
    setGroupB((prev) => ({ ...prev, [key]: val }));
  }, []);

  const handleCopy = useCallback(async () => {
    const all = { ...groupA, ...groupB };
    const json = JSON.stringify(all, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable
    }
  }, [groupA, groupB]);

  const handleReset = useCallback(() => {
    setGroupA({ ...GROUP_A_DEFAULTS });
    setGroupB({ ...GROUP_B_DEFAULTS });
  }, []);

  const handleRerender = useCallback(() => {
    setDiag(applyGroupBLive(groupB));
  }, [groupB]);

  return (
    <div style={s.panel} data-testid="heatmap-tuner">
      <div
        style={s.header}
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        aria-expanded={!collapsed}
      >
        <span>HEATMAP TUNER</span>
        <span aria-hidden>{collapsed ? '▼' : '▲'}</span>
      </div>
      {!collapsed && (
        <div style={s.body}>
          <div style={s.groupTitle}>GROUP A · LIVE</div>
          <Slider label="bandHeight" valueKey="bandHeight" value={groupA.bandHeight}
            range={GROUP_A_RANGES.bandHeight} onChange={(v) => updateA('bandHeight', v)} />
          <Slider label="scaleY" valueKey="scaleY" value={groupA.scaleY}
            range={GROUP_A_RANGES.scaleY} onChange={(v) => updateA('scaleY', v)} />
          <div style={s.row}>
            <div style={s.rowHeader}>
              <span style={s.label}>fillColor</span>
              <span style={s.value}>{groupA.fillColor}</span>
            </div>
            <input
              type="color"
              aria-label="fillColor"
              value={groupA.fillColor}
              onChange={(e) => updateA('fillColor', e.target.value)}
              style={s.colorInput}
            />
          </div>
          <Slider label="fillOpacity" valueKey="fillOpacity" value={groupA.fillOpacity}
            range={GROUP_A_RANGES.fillOpacity} onChange={(v) => updateA('fillOpacity', v)} />
          <div style={s.toggleRow}>
            <span style={s.label}>alwaysVisible</span>
            <input
              type="checkbox"
              aria-label="alwaysVisible"
              checked={groupA.alwaysVisible}
              onChange={(e) => updateA('alwaysVisible', e.target.checked)}
            />
          </div>

          <div style={s.groupTitle}>GROUP B · LIVE</div>
          <Slider label="sampling" valueKey="sampling" value={groupB.sampling}
            range={GROUP_B_RANGES.sampling} onChange={(v) => updateB('sampling', v)} />
          <Slider label="smoothing" valueKey="smoothing" value={groupB.smoothing}
            range={GROUP_B_RANGES.smoothing} onChange={(v) => updateB('smoothing', v)} />
          <Slider label="flattening" valueKey="flattening" value={groupB.flattening}
            range={GROUP_B_RANGES.flattening} onChange={(v) => updateB('flattening', v)} />
          <Slider label="scale" valueKey="scale" value={groupB.scale}
            range={GROUP_B_RANGES.scale} onChange={(v) => updateB('scale', v)} />
          <Slider label="minHeight" valueKey="minHeight" value={groupB.minHeight}
            range={GROUP_B_RANGES.minHeight} onChange={(v) => updateB('minHeight', v)} />

          {diag && (
            <div
              data-testid="heatmap-tuner-diag"
              style={{
                ...mono,
                fontSize: 10,
                color: diag.ok ? '#30d158' : '#ff453a',
                marginTop: 8,
                lineHeight: 1.5,
                wordBreak: 'break-all',
              }}
            >
              {diag.ok
                ? `OK · queue=${diag.queueLen} · vb=${diag.width}×${diag.height} · d=${diag.pathLen}b`
                : `FAIL · ${diag.reason}${diag.queueLen != null ? ` · queue=${diag.queueLen}` : ''}`}
            </div>
          )}

          <div style={s.buttonRow}>
            <button type="button" style={s.btn} onClick={handleCopy}>
              {copied ? <span style={s.btnConfirm}>COPIED!</span> : 'COPY JSON'}
            </button>
            <button type="button" style={s.btn} onClick={handleReset}>
              RESET
            </button>
            <button
              type="button"
              style={{ ...s.btn, ...s.btnPrimary }}
              onClick={handleRerender}
            >
              RE-RENDER
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
