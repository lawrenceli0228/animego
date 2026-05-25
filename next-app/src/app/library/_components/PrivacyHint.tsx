"use client";

// Shared library-import privacy reassurance (§5.9). Ported from
// client/src/components/shared/PrivacyHint.jsx — kept as a sibling
// _components file so both this subagent's LibraryEmptyState and
// subagent B's DropZone / ImportDrawer can import it via "./PrivacyHint"
// without crossing route segments.

import { mono } from "@/components/landing/shared/hud-tokens";

const PRIVACY_PULSE_CSS =
  "@keyframes privacyDot{0%,100%{opacity:0.55;transform:scale(0.92)}50%{opacity:1;transform:scale(1)}}";

const s: Record<string, React.CSSProperties> = {
  wrap: {
    ...mono,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize: 10,
    color: "rgba(235,235,245,0.55)",
    letterSpacing: "0.10em",
    textTransform: "uppercase",
    lineHeight: 1.4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#30d158",
    boxShadow: "0 0 6px #30d158",
    animation: "privacyDot 1.8s ease-in-out infinite",
    flexShrink: 0,
  },
};

interface PrivacyHintProps {
  compact?: boolean;
}

/**
 * PrivacyHint — §5.9 fixed reassurance shown on every import-adjacent surface.
 *
 *   ● 文件存储在此设备 · 不上传服务器
 *
 * Pulsing green dot + 10px mono. Use it inside DropZone, LibraryEmptyState,
 * ImportDrawer, and any other surface that touches user files.
 */
function PrivacyHint({ compact = false }: PrivacyHintProps) {
  return (
    <div style={s.wrap} data-testid="privacy-hint">
      <style>{PRIVACY_PULSE_CSS}</style>
      <span style={s.dot} aria-hidden />
      <span>
        {compact ? "本地存储 · 不上传" : "文件存储在此设备 · 不上传服务器"}
      </span>
    </div>
  );
}

export { PrivacyHint };
export default PrivacyHint;
