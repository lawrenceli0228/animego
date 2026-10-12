"use client";

/**
 * SubtitlePanel — the 字幕 popover inside the player.
 *
 * Every subtitle the episode has, in one list: the text tracks inside the
 * MKV (内封), the files beside the video (外挂), and any file the reader
 * loaded here (本地), plus "off". Under the list, the controls that only make
 * sense for the track that is showing: timing, and size / height for
 * plain-text subtitles.
 *
 * Rendered by VideoPlayer into artplayer's own player element through a
 * portal, so it stays on screen in fullscreen — a popover attached to the
 * page would be left behind when the player element goes fullscreen.
 *
 * Replaces three entries of artplayer's settings menu (size, position, "load
 * a subtitle file"). That menu has one icon for every entry, cannot show a
 * list with status, and the file it loaded went to the plaintext layer only,
 * where an ASS track already showing hid it.
 */

import { useEffect, useRef, type CSSProperties } from "react";
import { useLang } from "@/lib/lang-client";
import type { SubtitleTrack, SubtitleTracksState } from "../_services/subtitleTracks";

const SIZE_MIN = 14;
const SIZE_MAX = 48;
const POSITION_MIN = 10;
const POSITION_MAX = 200;

export interface SubtitlePanelProps {
  open: boolean;
  onClose: () => void;
  state: SubtitleTracksState;
  onSelect: (id: string | null) => void;
  onLoadFile: (file: File) => void;
  /** Seconds subtitles are shown later (negative: earlier). */
  delay: number;
  onDelayChange: (seconds: number) => void;
  size: number;
  onSizeChange: (px: number) => void;
  position: number;
  onPositionChange: (px: number) => void;
}

const ACCENT = "oklch(78% 0.15 200)";

const s: Record<string, CSSProperties> = {
  panel: {
    position: "absolute",
    right: 12,
    bottom: 60,
    zIndex: 120,
    width: 340,
    maxWidth: "calc(100% - 24px)",
    maxHeight: "calc(100% - 84px)",
    display: "flex",
    flexDirection: "column",
    background: "rgba(14,14,18,0.94)",
    border: "1px solid rgba(235,235,245,0.12)",
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
    color: "#fff",
    fontSize: 13,
    backdropFilter: "blur(10px)",
    overflow: "hidden",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 12px 8px 14px",
    borderBottom: "1px solid rgba(235,235,245,0.08)",
  },
  title: { fontWeight: 600, fontSize: 13, letterSpacing: "0.02em" },
  close: {
    background: "transparent",
    border: "none",
    color: "rgba(235,235,245,0.6)",
    fontSize: 16,
    lineHeight: 1,
    padding: 4,
    cursor: "pointer",
  },
  scan: {
    padding: "6px 14px",
    fontSize: 11,
    color: "rgba(235,235,245,0.55)",
    fontFamily: "'JetBrains Mono',monospace",
  },
  scanBar: { height: 2, background: "rgba(235,235,245,0.08)", margin: "0 14px 4px" },
  list: { overflowY: "auto", padding: "4px 6px", flex: "1 1 auto" },
  row: {
    width: "100%",
    display: "grid",
    gridTemplateColumns: "18px 1fr",
    gap: 8,
    alignItems: "start",
    textAlign: "left",
    background: "transparent",
    border: "none",
    borderRadius: 6,
    padding: "8px 8px",
    color: "inherit",
    cursor: "pointer",
    font: "inherit",
  },
  radio: {
    width: 14,
    height: 14,
    marginTop: 2,
    borderRadius: 9999,
    border: "1.5px solid rgba(235,235,245,0.45)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { width: 6, height: 6, borderRadius: 9999, background: ACCENT },
  primary: { fontSize: 13, lineHeight: 1.3, wordBreak: "break-word" },
  meta: {
    marginTop: 3,
    fontSize: 11,
    color: "rgba(235,235,245,0.5)",
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
  },
  chip: {
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 10,
    letterSpacing: "0.06em",
    padding: "1px 5px",
    borderRadius: 3,
    border: "1px solid rgba(235,235,245,0.18)",
    color: "rgba(235,235,245,0.7)",
  },
  file: {
    marginTop: 2,
    fontSize: 11,
    color: "rgba(235,235,245,0.35)",
    wordBreak: "break-all",
  },
  status: { fontSize: 11, color: "rgba(235,235,245,0.55)" },
  error: { fontSize: 11, color: "#ff8a80" },
  section: {
    borderTop: "1px solid rgba(235,235,245,0.08)",
    padding: "10px 14px 12px",
    display: "grid",
    gap: 10,
    flex: "0 0 auto",
  },
  ctlRow: {
    display: "grid",
    gridTemplateColumns: "44px 1fr",
    alignItems: "center",
    gap: 10,
  },
  ctlLabel: { fontSize: 12, color: "rgba(235,235,245,0.6)" },
  stepper: { display: "flex", alignItems: "center", gap: 6 },
  stepBtn: {
    minWidth: 30,
    height: 26,
    borderRadius: 4,
    border: "1px solid rgba(235,235,245,0.18)",
    background: "rgba(235,235,245,0.05)",
    color: "#fff",
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
  },
  stepValue: {
    minWidth: 64,
    textAlign: "center",
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 12,
  },
  resetBtn: {
    marginLeft: "auto",
    background: "transparent",
    border: "none",
    color: "rgba(235,235,245,0.55)",
    fontSize: 12,
    cursor: "pointer",
    padding: "4px 2px",
  },
  slider: { display: "flex", alignItems: "center", gap: 8 },
  sliderValue: {
    minWidth: 40,
    textAlign: "right",
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11,
    color: "rgba(235,235,245,0.6)",
  },
  hint: { fontSize: 11, color: "rgba(235,235,245,0.4)", lineHeight: 1.5 },
};

function fmtDelay(sec: number): string {
  const sign = sec > 0 ? "+" : sec < 0 ? "−" : "±";
  return `${sign}${Math.abs(sec).toFixed(1)} s`;
}

export function SubtitlePanel(props: SubtitlePanelProps) {
  const { t } = useLang();
  const { open, onClose, state } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Closing on a click anywhere outside — but not on the toggle button,
    // which handles its own click (and would otherwise reopen it).
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || panelRef.current?.contains(target)) return;
      if (target.closest?.(".art-control-subtitle-panel")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const active = state.tracks.find((tr) => tr.id === state.activeId) ?? null;
  const styled = active?.format === "ass" && !!active.assContent;
  const scanning = state.scan.state === "scanning";
  const pct = Math.round(state.scan.fraction * 100);

  const langLabel = (tr: SubtitleTrack) =>
    tr.lang ? t(`player.subs.lang.${tr.lang}`) : null;

  const rowFor = (tr: SubtitleTrack) => {
    const lang = langLabel(tr);
    const primary =
      tr.source === "embedded"
        ? lang ?? (tr.name || t("player.subs.untitled"))
        : lang ?? (tr.name || tr.fileName || t("player.subs.untitled"));
    const chips: string[] = [];
    if (tr.format !== "unknown") chips.push(tr.format === "image" ? "PGS" : tr.format.toUpperCase());
    chips.push(t(`player.subs.${tr.source}`));
    if (tr.isDefault && tr.source === "embedded") chips.push(t("player.subs.isDefault"));
    if (tr.isForced) chips.push(t("player.subs.forced"));
    if (tr.bilingual) chips.push(t("player.subs.bilingual"));
    // A name that says more than the language label ("简日双语", "Signs").
    const extraName = tr.source === "embedded" && tr.name && tr.name !== lang ? tr.name : null;
    const selected = tr.id === state.activeId;
    const disabled = !tr.supported || tr.status === "error";
    let status: React.ReactNode = null;
    if (tr.status === "unsupported") status = <span style={s.status}>{t("player.subs.unsupported")}</span>;
    else if (tr.status === "error") status = <span style={s.error}>{t("player.subs.error")}</span>;
    else if (tr.status === "loading") status = <span style={s.status}>{t("player.subs.loading")}</span>;
    else if (tr.status === "partial") status = <span style={s.status}>{t("player.subs.partial")}</span>;

    return (
      <button
        key={tr.id}
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        disabled={disabled}
        data-testid="subtitle-track"
        data-track-id={tr.id}
        onClick={() => props.onSelect(tr.id)}
        style={{
          ...s.row,
          background: selected ? "rgba(120,200,255,0.08)" : "transparent",
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        <span style={{ ...s.radio, borderColor: selected ? ACCENT : s.radio.border as string }}>
          {selected && <span style={s.dot} />}
        </span>
        <span>
          <span style={s.primary}>{primary}</span>
          <span style={s.meta}>
            {chips.map((c) => (
              <span key={c} style={s.chip}>
                {c}
              </span>
            ))}
            {extraName && <span>{extraName}</span>}
            {status}
          </span>
          {tr.fileName && <span style={{ ...s.file, display: "block" }}>{tr.fileName}</span>}
        </span>
      </button>
    );
  };

  const hasUsable = state.tracks.some((tr) => tr.supported && tr.status !== "error");

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("player.subs.title")}
      data-testid="subtitle-panel"
      style={s.panel}
      // Clicks inside must not reach artplayer, which toggles play on them.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div style={s.head}>
        <span style={s.title}>{t("player.subs.title")}</span>
        <button type="button" style={s.close} onClick={onClose} aria-label="close">
          ✕
        </button>
      </div>

      {scanning && (
        <>
          <div style={s.scan}>{t("player.subs.scanning").replace("{{pct}}", String(pct))}</div>
          <div style={s.scanBar}>
            <div style={{ width: `${pct}%`, height: "100%", background: ACCENT, transition: "width 200ms" }} />
          </div>
        </>
      )}

      <div style={s.list} role="menu">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={state.activeId === null}
          data-testid="subtitle-off"
          onClick={() => props.onSelect(null)}
          style={{ ...s.row, background: state.activeId === null ? "rgba(120,200,255,0.08)" : "transparent" }}
        >
          <span style={{ ...s.radio, borderColor: state.activeId === null ? ACCENT : (s.radio.border as string) }}>
            {state.activeId === null && <span style={s.dot} />}
          </span>
          <span style={s.primary}>{t("player.subs.off")}</span>
        </button>
        {state.tracks.map(rowFor)}
        {!hasUsable && !scanning && state.decided && (
          <div style={{ ...s.hint, padding: "6px 8px" }}>{t("player.subs.none")}</div>
        )}
        <button
          type="button"
          data-testid="subtitle-load-file"
          onClick={() => fileRef.current?.click()}
          style={{ ...s.row, color: ACCENT }}
        >
          <span style={{ textAlign: "center" }}>＋</span>
          <span>
            <span style={s.primary}>{t("player.subs.loadFile")}</span>
            <span style={s.meta}>{t("player.subs.loadFileHint")}</span>
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".ass,.ssa,.srt,.vtt"
          style={{ display: "none" }}
          data-testid="subtitle-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) props.onLoadFile(file);
          }}
        />
      </div>

      {active && (
        <div style={s.section}>
          <div style={s.ctlRow}>
            <span style={s.ctlLabel}>{t("player.subs.timing")}</span>
            <div style={s.stepper}>
              <button
                type="button"
                style={s.stepBtn}
                aria-label={t("player.subs.earlier")}
                title={t("player.subs.earlier")}
                data-testid="subtitle-earlier"
                onClick={() => props.onDelayChange(Math.round((props.delay - 0.5) * 10) / 10)}
              >
                −
              </button>
              <span style={s.stepValue} data-testid="subtitle-delay">
                {fmtDelay(props.delay)}
              </span>
              <button
                type="button"
                style={s.stepBtn}
                aria-label={t("player.subs.later")}
                title={t("player.subs.later")}
                data-testid="subtitle-later"
                onClick={() => props.onDelayChange(Math.round((props.delay + 0.5) * 10) / 10)}
              >
                +
              </button>
              {props.delay !== 0 && (
                <button type="button" style={s.resetBtn} onClick={() => props.onDelayChange(0)}>
                  {t("player.subs.reset")}
                </button>
              )}
            </div>
          </div>
          <div style={s.hint}>{t("player.subs.timingHint")}</div>
          {!styled && (
            <>
              <label style={s.ctlRow}>
                <span style={s.ctlLabel}>{t("player.subs.size")}</span>
                <span style={s.slider}>
                  <input
                    type="range"
                    min={SIZE_MIN}
                    max={SIZE_MAX}
                    step={2}
                    value={props.size}
                    onChange={(e) => props.onSizeChange(Number(e.target.value))}
                    style={{ flex: 1, accentColor: ACCENT }}
                  />
                  <span style={s.sliderValue}>{props.size}px</span>
                </span>
              </label>
              <label style={s.ctlRow}>
                <span style={s.ctlLabel}>{t("player.subs.position")}</span>
                <span style={s.slider}>
                  <input
                    type="range"
                    min={POSITION_MIN}
                    max={POSITION_MAX}
                    step={5}
                    value={props.position}
                    onChange={(e) => props.onPositionChange(Number(e.target.value))}
                    style={{ flex: 1, accentColor: ACCENT }}
                  />
                  <span style={s.sliderValue}>{props.position}px</span>
                </span>
              </label>
            </>
          )}
          {styled && <div style={s.hint}>{t("player.subs.styledHint")}</div>}
        </div>
      )}
    </div>
  );
}

export default SubtitlePanel;
