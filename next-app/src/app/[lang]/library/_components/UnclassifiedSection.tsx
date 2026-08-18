"use client";

import { useMemo, useState } from "react";
import { mono, PLAYER_HUE } from "@/components/landing/shared/hud-tokens";
import { useLang } from "@/lib/lang-client";

type MatchStatus = "pending" | "failed" | "ambiguous" | string;

interface FileRef {
  id: string;
  relPath?: string;
  matchStatus: MatchStatus;
  [k: string]: unknown;
}

const HUE = PLAYER_HUE.stream;
const AMBER = 40;

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: "PENDING", color: "oklch(72% 0.16 210)" },
  failed: { label: "UNKNOWN", color: "oklch(70% 0.20 25)" },
  ambiguous: { label: "LOW CONF", color: "oklch(78% 0.16 70)" },
};

const s = {
  wrap: {
    border: `1px solid oklch(60% 0.13 ${AMBER} / 0.40)`,
    borderRadius: 4,
    background: `oklch(14% 0.04 ${AMBER} / 0.20)`,
    overflow: "hidden",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "12px 16px",
    cursor: "pointer",
    background: `oklch(16% 0.05 ${AMBER} / 0.45)`,
    borderBottom: `1px solid oklch(60% 0.13 ${AMBER} / 0.30)`,
  } as React.CSSProperties,
  headerCollapsed: {
    borderBottom: "none",
  } as React.CSSProperties,
  kicker: {
    ...mono,
    fontSize: 11,
    color: `oklch(78% 0.14 ${AMBER})`,
    textTransform: "uppercase",
    letterSpacing: "0.16em",
  } as React.CSSProperties,
  count: {
    ...mono,
    fontSize: 10,
    color: "rgba(235,235,245,0.55)",
    letterSpacing: "0.10em",
  } as React.CSSProperties,
  caret: {
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.55)",
    transition: "transform 150ms ease",
  } as React.CSSProperties,
  list: {
    display: "flex",
    flexDirection: "column",
    maxHeight: 360,
    overflowY: "auto",
  } as React.CSSProperties,
  row: {
    ...mono,
    display: "grid",
    gridTemplateColumns: "70px 1fr auto",
    gap: 14,
    alignItems: "center",
    padding: "10px 16px",
    fontSize: 11,
    borderTop: "1px solid oklch(46% 0.06 0 / 0.10)",
  } as React.CSSProperties,
  status: {
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.10em",
    fontWeight: 600,
  } as React.CSSProperties,
  fileName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "rgba(235,235,245,0.85)",
  } as React.CSSProperties,
  rowMeta: {
    ...mono,
    fontSize: 10,
    color: "rgba(235,235,245,0.40)",
    letterSpacing: "0.04em",
    marginTop: 2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  fileBlock: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: 6,
    flexShrink: 0,
  } as React.CSSProperties,
  btn: {
    ...mono,
    padding: "5px 10px",
    background: "transparent",
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.50)`,
    borderRadius: 2,
    color: "rgba(235,235,245,0.85)",
    cursor: "pointer",
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.10em",
  } as React.CSSProperties,
  btnDanger: {
    // Mirror `btn.border` shape (shorthand) so merging `{...btn, ...btnDanger}`
    // doesn't produce a mixed `border` (shorthand) + `borderColor` (longhand)
    // style object — React's rerender diff complains about that combination.
    border: "1px solid oklch(60% 0.20 25 / 0.50)",
    color: "oklch(72% 0.18 25)",
  } as React.CSSProperties,
};

/**
 * Trim relPath to its file name. Returns the original string if no slash found.
 */
function fileNameOf(p: string | undefined): string {
  if (!p) return "";
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Trim relPath to its parent directory. Returns rootLabel for root files.
 */
function dirOf(p: string | undefined, rootLabel: string): string {
  if (!p) return "";
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : rootLabel;
}

interface UnclassifiedSectionProps {
  entries: FileRef[];
  defaultOpen?: boolean;
  onSearch?: (fileRef: FileRef) => void;
  onCreateLocal?: (fileRef: FileRef) => void;
  onIgnore?: (fileRef: FileRef) => void;
}

/**
 * UnclassifiedSection — collapsible bottom block on LibraryPage that surfaces
 * fileRefs the matcher couldn't confidently bind (pending / failed / ambiguous).
 *
 * Per row the user sees the file name + status + 3 actions:
 *   [搜索归番] — opens a manual search flow (parent-supplied)
 *   [创建本地系列] — creates a no-dandanplay local series (parent-supplied)
 *   [忽略] — drops the fileRef (parent-supplied; usually deletes from db)
 *
 * Empty list → renders nothing so the page doesn't accrete dead chrome.
 */
function UnclassifiedSection({
  entries,
  defaultOpen = false,
  onSearch,
  onCreateLocal,
  onIgnore,
}: UnclassifiedSectionProps) {
  const { t } = useLang();
  const rows = entries ?? [];
  const [open, setOpen] = useState(defaultOpen);
  const rootLabel = t("library.localSeries.rootFolder");

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) =>
      (a.relPath || "").localeCompare(b.relPath || ""),
    );
  }, [rows]);

  if (rows.length === 0) return null;

  return (
    <section data-testid="unclassified-section" style={s.wrap}>
      <button
        type="button"
        data-testid="unclassified-toggle"
        style={{
          ...s.header,
          ...(open ? null : s.headerCollapsed),
          border: "none",
          width: "100%",
          textAlign: "left",
        }}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span style={s.kicker}>{"// UNCLASSIFIED //"}</span>
        <span style={s.count} data-testid="unclassified-count">
          {t("library.unclassified.fileCount").replace("{{count}}", String(rows.length))}
        </span>
        <span
          style={{
            ...s.caret,
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
          }}
          aria-hidden
        >
          ›
        </span>
      </button>

      {open && (
        <div style={s.list} data-testid="unclassified-list">
          {sorted.map((fr) => {
            const meta = STATUS_LABELS[fr.matchStatus] ?? STATUS_LABELS.pending;
            return (
              <div
                key={fr.id}
                data-testid={`unclassified-row-${fr.id}`}
                style={s.row}
              >
                <span style={{ ...s.status, color: meta.color }}>
                  {meta.label}
                </span>
                <div style={s.fileBlock}>
                  <span style={s.fileName} title={fr.relPath}>
                    {fileNameOf(fr.relPath)}
                  </span>
                  <span style={s.rowMeta}>{dirOf(fr.relPath, rootLabel)}</span>
                </div>
                <div style={s.actions}>
                  <button
                    type="button"
                    data-testid={`unclassified-search-${fr.id}`}
                    style={s.btn}
                    onClick={() => onSearch?.(fr)}
                    disabled={!onSearch}
                  >
                    {t("library.unclassified.searchAnime")}
                  </button>
                  <button
                    type="button"
                    data-testid={`unclassified-create-${fr.id}`}
                    style={s.btn}
                    onClick={() => onCreateLocal?.(fr)}
                    disabled={!onCreateLocal}
                  >
                    {t("library.unclassified.createLocal")}
                  </button>
                  <button
                    type="button"
                    data-testid={`unclassified-ignore-${fr.id}`}
                    style={{ ...s.btn, ...s.btnDanger }}
                    onClick={() => onIgnore?.(fr)}
                    disabled={!onIgnore}
                  >
                    {t("library.unclassified.ignore")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export { UnclassifiedSection };
export default UnclassifiedSection;
