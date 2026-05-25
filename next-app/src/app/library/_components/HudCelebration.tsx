"use client";

// Ported from client/src/components/library/HudCelebration.jsx.
// Full-screen HUD readout fired once per import completion. ~1.4s total
// animation budget; click anywhere to skip; reduced-motion users skip the
// overlay entirely (still calls onComplete so the parent can clear its
// trigger key).

import { useEffect, useState, type CSSProperties } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import {
  mono,
  PLAYER_HUE,
  LOCAL_HEX_GLYPH,
} from "@/components/landing/shared/hud-tokens";

const HUE = PLAYER_HUE.local;

const s = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: `oklch(8% 0.02 ${HUE} / 0.78)`,
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    zIndex: 1000,
    cursor: "pointer",
  } as CSSProperties,
  title: {
    ...mono,
    fontSize: "clamp(20px, 2.5vw, 30px)",
    letterSpacing: "0.16em",
    color: `oklch(78% 0.16 ${HUE})`,
    textTransform: "uppercase",
    display: "flex",
    alignItems: "center",
    gap: 16,
    textShadow: `0 0 22px oklch(72% 0.18 ${HUE} / 0.45)`,
    pointerEvents: "none",
  } as CSSProperties,
  readout: {
    ...mono,
    fontSize: 13,
    letterSpacing: "0.10em",
    color: "rgba(235,235,245,0.65)",
    textTransform: "uppercase",
    display: "flex",
    gap: 14,
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "center",
    pointerEvents: "none",
  } as CSSProperties,
  num: { color: "#fff", fontWeight: 600 } as CSSProperties,
  dot: { color: "rgba(235,235,245,0.30)" } as CSSProperties,
  frame: {
    position: "absolute",
    width: "min(64vw, 720px)",
    height: "min(36vh, 280px)",
    pointerEvents: "none",
    color: `oklch(72% 0.16 ${HUE} / 0.45)`,
  } as CSSProperties,
  corner: (pos: "tl" | "tr" | "bl" | "br"): CSSProperties => {
    const sz = 28;
    const base: CSSProperties = { position: "absolute", width: sz, height: sz };
    const stroke = "1px solid currentColor";
    if (pos === "tl")
      return { ...base, top: 0, left: 0, borderTop: stroke, borderLeft: stroke };
    if (pos === "tr")
      return {
        ...base,
        top: 0,
        right: 0,
        borderTop: stroke,
        borderRight: stroke,
      };
    if (pos === "bl")
      return {
        ...base,
        bottom: 0,
        left: 0,
        borderBottom: stroke,
        borderLeft: stroke,
      };
    return {
      ...base,
      bottom: 0,
      right: 0,
      borderBottom: stroke,
      borderRight: stroke,
    };
  },
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

interface HudCelebrationProps {
  triggerKey: number | string | null;
  seriesCount: number;
  episodeCount: number;
  bytesIndexed?: number;
  onComplete?: () => void;
}

export function HudCelebration({
  triggerKey,
  seriesCount,
  episodeCount,
  bytesIndexed,
  onComplete,
}: HudCelebrationProps) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (triggerKey == null) return undefined;
    if (reduced) {
      onComplete?.();
      return undefined;
    }
    setOpen(true);
    const timer = setTimeout(() => {
      setOpen(false);
    }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKey, reduced]);

  if (reduced) return null;

  function handleSkip() {
    setOpen(false);
  }

  return (
    <AnimatePresence onExitComplete={() => onComplete?.()}>
      {open && (
        <motion.div
          style={s.overlay}
          data-testid="hud-celebration"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          onClick={handleSkip}
        >
          <div style={s.frame} aria-hidden>
            <span style={s.corner("tl")} />
            <span style={s.corner("tr")} />
            <span style={s.corner("bl")} />
            <span style={s.corner("br")} />
          </div>
          <motion.div
            style={s.title}
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 6, opacity: 0 }}
            transition={{
              duration: 0.32,
              delay: 0.06,
              ease: [0.16, 1, 0.3, 1],
            }}
          >
            <span aria-hidden>{`// LIBRARY READY ${LOCAL_HEX_GLYPH} //`}</span>
          </motion.div>
          <motion.div
            style={s.readout}
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 6, opacity: 0 }}
            transition={{
              duration: 0.32,
              delay: 0.14,
              ease: [0.16, 1, 0.3, 1],
            }}
            data-testid="hud-celebration-readout"
          >
            <span>
              <span style={s.num}>{seriesCount}</span>
              <span>&nbsp;SERIES</span>
            </span>
            <span style={s.dot}>·</span>
            <span>
              <span style={s.num}>{episodeCount}</span>
              <span>&nbsp;EPISODES</span>
            </span>
            {bytesIndexed != null && bytesIndexed > 0 && (
              <>
                <span style={s.dot}>·</span>
                <span>
                  <span style={s.num}>{formatBytes(bytesIndexed)}</span>
                  <span>&nbsp;INDEXED</span>
                </span>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
