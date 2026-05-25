"use client";

// Placeholder for the legacy `client/src/components/player/ManualSearch.jsx`
// which the P6.6 Player fan-out (subagent C) will port. RematchDialog
// imports it via next/dynamic so the rematch flow can mount before the real
// search UI is available — surfacing a clear "not implemented yet" message
// instead of crashing on a missing import path.
//
// TODO P6 verify: delete this file once the real ManualSearch lands and
// update the import path in RematchDialog.tsx to point at it.

import { mono } from "@/components/landing/shared/hud-tokens";

interface ManualSearchPlaceholderProps {
  defaultKeyword: string;
  onSelect: (item: unknown) => void;
  onBack: () => void;
}

export function ManualSearchPlaceholder({
  defaultKeyword,
  onBack,
}: ManualSearchPlaceholderProps) {
  return (
    <div style={s.wrap} data-testid="manual-search-placeholder">
      <div style={s.heading}>{"// MANUAL SEARCH "}</div>
      <p style={s.body}>
        手动搜索功能尚未在 next-app 中实现 (P6.6 阶段移植中)。
      </p>
      <p style={s.hint}>
        默认关键字: <code style={s.code}>{defaultKeyword || "—"}</code>
      </p>
      <button type="button" style={s.btn} onClick={onBack}>
        返回
      </button>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap: {
    padding: 24,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    color: "#fff",
  },
  heading: {
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.45)",
    letterSpacing: "0.18em",
    textTransform: "uppercase",
  },
  body: {
    fontSize: 13,
    color: "rgba(235,235,245,0.75)",
    margin: 0,
    lineHeight: 1.5,
  },
  hint: {
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.45)",
    margin: 0,
    letterSpacing: "0.05em",
  },
  code: {
    ...mono,
    background: "rgba(255,255,255,0.05)",
    color: "#5ac8fa",
    padding: "1px 6px",
    borderRadius: 3,
  },
  btn: {
    ...mono,
    alignSelf: "flex-start",
    padding: "6px 14px",
    background: "transparent",
    border: "1px solid rgba(235,235,245,0.25)",
    borderRadius: 3,
    color: "rgba(235,235,245,0.85)",
    cursor: "pointer",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
  },
};
