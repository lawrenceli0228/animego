"use client";

import { useSearchParams } from "next/navigation";

// P6.5 placeholder shell. P6.6's three parallel subagents will replace
// the body with the real artplayer + jassub overlay + danmaku + episode
// list. For now this just acknowledges the URL hand-off contract from
// LibraryShell (?seriesId=&fileId=) so /player at least renders past
// the dynamic-import boundary.

export function PlayerShell() {
  const sp = useSearchParams();
  const seriesId = sp.get("seriesId");
  const fileId = sp.get("fileId");
  const resumeEpisode = sp.get("resumeEpisode");

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>播放器 (P6.5 占位)</h1>
        <p style={styles.note}>
          P6.6 即将填充 artplayer + jassub overlay + danmaku +
          episode list.
        </p>
        <dl style={styles.dl}>
          <div style={styles.row}>
            <dt style={styles.dt}>seriesId</dt>
            <dd style={styles.dd}>{seriesId ?? "—"}</dd>
          </div>
          <div style={styles.row}>
            <dt style={styles.dt}>fileId</dt>
            <dd style={styles.dd}>{fileId ?? "—"}</dd>
          </div>
          <div style={styles.row}>
            <dt style={styles.dt}>resumeEpisode</dt>
            <dd style={styles.dd}>{resumeEpisode ?? "—"}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#0b0b10",
    color: "#e7e7ef",
    padding: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    width: "100%",
    maxWidth: 720,
    padding: 32,
    background: "#15151f",
    border: "1px solid #1f1f2a",
    borderRadius: 10,
  },
  title: {
    fontSize: 20,
    fontWeight: 600,
    margin: "0 0 12px 0",
  },
  note: {
    fontSize: 14,
    color: "#9090a0",
    margin: "0 0 24px 0",
  },
  dl: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    margin: 0,
  },
  row: {
    display: "flex",
    gap: 16,
  },
  dt: {
    width: 140,
    fontSize: 12,
    color: "#7c7c8c",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  dd: {
    fontSize: 14,
    margin: 0,
    color: "#e7e7ef",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
};
