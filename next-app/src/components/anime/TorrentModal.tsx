"use client";

// v1 TorrentModal: the legacy `/api/torrents` route was removed
// upstream (Go API returns 404 NOT_FOUND for `/api/torrents`), so
// this surface renders the empty-state copy and a "search externally"
// escape hatch. When the search endpoint comes back online, swap the
// empty-state body for the real torrent list — header, backdrop, esc
// handling, and lifecycle plumbing all stay as-is.

import { useEffect } from "react";

interface TorrentModalProps {
  anime: {
    anilistId: number;
    titleRomaji: string | null;
    titleEnglish: string | null;
    titleChinese: string | null;
    titleNative: string | null;
    coverImageUrl: string | null;
  };
  labels: {
    title: string;
    empty: string;
    searchExternally: string;
    close: string;
  };
  onClose: () => void;
}

const backdropStyle = {
  position: "fixed" as const,
  inset: 0,
  background: "rgba(0,0,0,0.80)",
  backdropFilter: "blur(8px)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
} as const;

const cardStyle = {
  background: "#000000",
  border: "1px solid rgba(120,120,128,0.12)",
  borderRadius: 16,
  width: "100%",
  maxWidth: 720,
  maxHeight: "min(80vh, 600px)",
  display: "flex",
  flexDirection: "column" as const,
  overflow: "hidden",
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 18px",
  borderBottom: "1px solid rgba(84,84,88,0.30)",
} as const;

const titleStyle = {
  color: "#0a84ff",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "2px",
  textTransform: "uppercase" as const,
} as const;

const closeBtnStyle = {
  background: "none",
  border: "none",
  color: "rgba(235,235,245,0.55)",
  cursor: "pointer",
  fontSize: 20,
  lineHeight: 1,
  padding: 4,
} as const;

const bodyStyle = {
  flex: 1,
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  padding: "48px 24px",
  textAlign: "center" as const,
} as const;

const emptyTextStyle = {
  color: "rgba(235,235,245,0.55)",
  fontSize: 14,
  lineHeight: 1.6,
  maxWidth: 380,
} as const;

const searchLinkStyle = {
  display: "inline-block",
  padding: "10px 18px",
  borderRadius: 8,
  border: "1px solid rgba(10,132,255,0.45)",
  background: "rgba(10,132,255,0.12)",
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
} as const;

export default function TorrentModal({
  anime,
  labels,
  onClose,
}: TorrentModalProps) {
  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Body scroll lock while the modal is mounted.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  const query =
    anime.titleRomaji ||
    anime.titleEnglish ||
    anime.titleChinese ||
    anime.titleNative ||
    "";
  const externalUrl = `https://nyaa.si/?q=${encodeURIComponent(query)}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      style={backdropStyle}
      onClick={onClose}
    >
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <span style={titleStyle}>{labels.title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={labels.close}
            style={closeBtnStyle}
          >
            {"✕"}
          </button>
        </div>
        <div style={bodyStyle}>
          <p style={emptyTextStyle}>{labels.empty}</p>
          {query && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={searchLinkStyle}
            >
              {labels.searchExternally}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
