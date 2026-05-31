"use client";

// Ported from client/src/components/library/OpsLogDrawer.jsx.
// §5.6 v3 操作日志抽屉 — 24h ops history surface for the series detail page.
// Pure rendering component; the parent loads entries and passes them in.

import { useEffect, useRef, type CSSProperties } from "react";
import { mono, PLAYER_HUE } from "@/components/landing/shared/hud-tokens";
import { CornerBrackets } from "@/components/landing/shared/hud";
import { useLang } from "@/lib/lang-client";

export interface OpsLogEntry {
  id: string;
  seriesId: string;
  ts: number;
  kind: "merge" | "split" | "rematch" | "unfile" | "delete";
  payload?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  undoableUntil?: number;
  undone?: boolean;
}

const HUE = PLAYER_HUE.stream;

interface KindMeta {
  glyph: string;
  label: string;
  color: string;
}

// label values are i18n keys resolved at render time via t()
const KIND_META: Record<string, KindMeta> = {
  merge: { glyph: "⇉", label: "library.opsLog.kindMerge", color: `oklch(72% 0.15 ${HUE})` },
  split: { glyph: "⇇", label: "library.opsLog.kindSplit", color: "oklch(75% 0.15 145)" },
  rematch: { glyph: "⟲", label: "library.opsLog.kindRematch", color: "oklch(78% 0.16 70)" },
  unfile: { glyph: "✕", label: "library.opsLog.kindUnfile", color: "rgba(235,235,245,0.55)" },
  delete: { glyph: "⌫", label: "library.opsLog.kindDelete", color: "oklch(70% 0.20 25)" },
};

const s = {
  scrim: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    zIndex: 800,
  } as CSSProperties,
  drawer: {
    position: "fixed",
    top: 24,
    right: 24,
    width: 380,
    maxWidth: "calc(100vw - 48px)",
    maxHeight: "calc(100vh - 48px)",
    display: "flex",
    flexDirection: "column",
    background: `oklch(12% 0.03 ${HUE} / 0.96)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 6,
    boxShadow: "0 8px 32px oklch(2% 0 0 / 0.6)",
    color: "#fff",
    overflow: "hidden",
    zIndex: 900,
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
  } as CSSProperties,
  header: {
    padding: "14px 18px 10px",
    borderBottom: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  } as CSSProperties,
  kicker: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE})`,
    textTransform: "uppercase",
    letterSpacing: "0.18em",
  } as CSSProperties,
  closeBtn: {
    ...mono,
    background: "transparent",
    border: "none",
    color: "rgba(235,235,245,0.65)",
    cursor: "pointer",
    fontSize: 14,
    padding: 4,
    lineHeight: 1,
  } as CSSProperties,
  list: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 6px",
    display: "flex",
    flexDirection: "column",
    gap: 2,
  } as CSSProperties,
  empty: {
    ...mono,
    padding: "32px 18px",
    textAlign: "center",
    color: "rgba(235,235,245,0.55)",
    fontSize: 11,
    letterSpacing: "0.05em",
  } as CSSProperties,
  row: {
    display: "grid",
    gridTemplateColumns: "24px 1fr auto",
    gap: 10,
    alignItems: "start",
    padding: "10px 12px",
    fontSize: 12,
  } as CSSProperties,
  rowUndone: {
    opacity: 0.45,
  } as CSSProperties,
  glyph: {
    ...mono,
    fontSize: 13,
    textAlign: "center",
    lineHeight: "18px",
  } as CSSProperties,
  body: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    minWidth: 0,
  } as CSSProperties,
  kindLabel: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE})`,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
  } as CSSProperties,
  summary: {
    fontSize: 12,
    color: "rgba(235,235,245,0.85)",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } as CSSProperties,
  summaryUndone: {
    textDecoration: "line-through",
  } as CSSProperties,
  ts: {
    ...mono,
    fontSize: 10,
    color: "rgba(235,235,245,0.40)",
    letterSpacing: "0.05em",
  } as CSSProperties,
  undoneTag: {
    ...mono,
    fontSize: 9,
    color: "rgba(235,235,245,0.55)",
    border: "1px solid rgba(235,235,245,0.20)",
    borderRadius: 2,
    padding: "1px 5px",
    textTransform: "uppercase",
    letterSpacing: "0.10em",
    alignSelf: "flex-start",
  } as CSSProperties,
};

/** Relative time formatter — language resolved via t(). */
export function formatTimeAgo(
  ts: number,
  now: number = Date.now(),
  t?: (key: string) => string,
): string {
  const tr = (key: string, n: number) =>
    t ? t(key).replace("{{n}}", String(n)) : key;
  const diff = Math.floor((now - ts) / 1000);
  if (diff < 60) return t ? t("library.opsLog.timeJustNow") : "just now";
  if (diff < 3600) return tr("library.opsLog.timeMinutesAgo", Math.floor(diff / 60));
  if (diff < 86400) return tr("library.opsLog.timeHoursAgo", Math.floor(diff / 3600));
  const days = Math.floor(diff / 86400);
  if (days < 30) return tr("library.opsLog.timeDaysAgo", days);
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function summaryLineFor(entry: OpsLogEntry, t: (key: string) => string): string {
  const sum = (entry.summary ?? {}) as Record<string, string | number | undefined>;
  const target = typeof sum.targetTitle === "string" ? sum.targetTitle : "";
  const source = typeof sum.sourceTitle === "string" ? sum.sourceTitle : "";
  const name = typeof sum.name === "string" ? sum.name : "";
  switch (entry.kind) {
    case "merge":
      if (source && target)
        return t("library.opsLog.summaryMergeBoth")
          .replace("{{source}}", source)
          .replace("{{target}}", target);
      if (target)
        return t("library.opsLog.summaryMergeTarget").replace("{{target}}", target);
      return t("library.opsLog.summaryMerge");
    case "split":
      if (name)
        return t("library.opsLog.summarySplitName").replace("{{name}}", name);
      return t("library.opsLog.summarySplit");
    case "rematch":
      if (target)
        return t("library.opsLog.summaryRematchTarget").replace("{{target}}", target);
      return t("library.opsLog.summaryRematch");
    case "unfile":
      return t("library.opsLog.summaryUnfile");
    case "delete":
      return t("library.opsLog.summaryDelete");
    default:
      return entry.kind;
  }
}

interface OpsLogDrawerProps {
  open: boolean;
  entries: OpsLogEntry[];
  onClose: () => void;
  now?: number;
}

export function OpsLogDrawer({
  open,
  entries,
  onClose,
  now,
}: OpsLogDrawerProps) {
  const { t } = useLang();
  const drawerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        style={s.scrim}
        data-testid="opslog-scrim"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={drawerRef}
        role="dialog"
        aria-label={t("library.opsLog.ariaLabel")}
        data-testid="opslog-drawer"
        style={s.drawer}
      >
        <CornerBrackets inset={4} size={10} opacity={0.35} hue={HUE} />

        <div style={s.header}>
          <span style={s.kicker} data-testid="opslog-title">
            // OPS.LOG · 24H //
          </span>
          <button
            type="button"
            data-testid="opslog-close"
            style={s.closeBtn}
            onClick={onClose}
            aria-label={t("library.opsLog.close")}
          >
            ×
          </button>
        </div>

        <div style={s.list} data-testid="opslog-list">
          {entries.length === 0 ? (
            <div style={s.empty} data-testid="opslog-empty">
              {t("library.opsLog.empty")}
            </div>
          ) : (
            entries.map((entry) => {
              const meta = KIND_META[entry.kind] ?? {
                glyph: "·",
                label: entry.kind,
                color: "rgba(235,235,245,0.55)",
              };
              const undone = !!entry.undone;
              return (
                <div
                  key={entry.id}
                  data-testid={`opslog-row-${entry.id}`}
                  data-kind={entry.kind}
                  data-undone={undone ? "1" : "0"}
                  style={{ ...s.row, ...(undone ? s.rowUndone : null) }}
                >
                  <span style={{ ...s.glyph, color: meta.color }} aria-hidden>
                    {meta.glyph}
                  </span>
                  <div style={s.body}>
                    <span style={s.kindLabel}>{t(meta.label)}</span>
                    <span
                      style={{
                        ...s.summary,
                        ...(undone ? s.summaryUndone : null),
                      }}
                    >
                      {summaryLineFor(entry, t)}
                    </span>
                    <span style={s.ts}>{formatTimeAgo(entry.ts, now, t)}</span>
                  </div>
                  {undone && (
                    <span
                      style={s.undoneTag}
                      data-testid={`opslog-undone-${entry.id}`}
                    >
                      UNDONE
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
