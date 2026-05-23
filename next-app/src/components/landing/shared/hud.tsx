"use client";

import type { CSSProperties, ReactNode } from "react";
import { motion as Motion, useReducedMotion } from "motion/react";
import { HUD_VIEWPORT } from "./hud-tokens";

/* --- SectionNum — top-right "§0X" chapter marker ---------------------- */

const sectionNumStyle: CSSProperties = {
  position: "absolute",
  top: 28,
  right: 32,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  letterSpacing: "0.14em",
  color: "rgba(235,235,245,0.30)",
  textTransform: "uppercase",
  zIndex: 2,
};

interface SectionNumProps {
  n: string;
  style?: CSSProperties;
  delay?: number;
}

export function SectionNum({ n, style, delay = 0.2 }: SectionNumProps) {
  const reduced = useReducedMotion();
  return (
    <Motion.span
      style={{ ...sectionNumStyle, ...style }}
      initial={reduced ? false : { opacity: 0 }}
      animate={reduced ? undefined : { opacity: 1 }}
      transition={{ duration: 0.4, delay, ease: "easeOut" }}
      aria-hidden
    >
      §{n}
    </Motion.span>
  );
}

/* --- SectionHeader — eyebrow + title + sub ---------------------------- */

const headerStyles = {
  wrap: { maxWidth: 720, marginBottom: 64, position: "relative", zIndex: 1 } as CSSProperties,
  eyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: "0.12em",
    color: "rgba(235,235,245,0.30)",
    textTransform: "uppercase",
    marginBottom: 16,
  } as CSSProperties,
  title: {
    fontFamily: "'Sora', sans-serif",
    fontSize: "clamp(2rem, 1rem + 3vw, 3.5rem)",
    fontWeight: 800,
    color: "#fff",
    letterSpacing: "-0.03em",
    lineHeight: 1.1,
    marginBottom: 20,
  } as CSSProperties,
  sub: {
    fontSize: 16,
    color: "rgba(235,235,245,0.60)",
    lineHeight: 1.6,
    maxWidth: 560,
  } as CSSProperties,
};

interface SectionHeaderProps {
  eyebrow?: ReactNode;
  title?: ReactNode;
  sub?: ReactNode;
  titleId?: string;
  style?: CSSProperties;
}

export function SectionHeader({
  eyebrow,
  title,
  sub,
  titleId,
  style,
}: SectionHeaderProps) {
  return (
    <header style={{ ...headerStyles.wrap, ...style }}>
      {eyebrow && <div style={headerStyles.eyebrow}>{eyebrow}</div>}
      {title && (
        <h2 id={titleId} style={headerStyles.title}>
          {title}
        </h2>
      )}
      {sub && <p style={headerStyles.sub}>{sub}</p>}
    </header>
  );
}

/* --- ChapterBar — OKLCH column, scaleY entrance ------------------------ */

function chapterBarStyle(
  hue: number,
  height: number,
  top: number,
  left: number,
  width: number,
  orientation: "vertical" | "horizontal",
): CSSProperties {
  const horizontal = orientation === "horizontal";
  return {
    position: "absolute",
    top,
    left,
    width: horizontal ? height : width,
    height: horizontal ? width : height,
    background: `oklch(62% 0.19 ${hue})`,
    borderRadius: 2,
    boxShadow: `0 0 24px oklch(62% 0.19 ${hue} / 0.55)`,
    transformOrigin: horizontal ? "left" : "top",
  };
}

interface ChapterBarProps {
  hue?: number;
  height?: number;
  width?: number;
  top?: number;
  left?: number;
  delay?: number;
  orientation?: "vertical" | "horizontal";
  trigger?: "inView" | "mount";
  style?: CSSProperties;
  className?: string;
}

export function ChapterBar({
  hue = 210,
  height = 52,
  width = 3,
  top = 28,
  left = 28,
  delay = 0,
  orientation = "vertical",
  trigger = "inView",
  style,
  className,
}: ChapterBarProps) {
  const reduced = useReducedMotion();
  const horizontal = orientation === "horizontal";
  const initial = reduced
    ? false
    : horizontal
      ? { scaleX: 0 }
      : { scaleY: 0 };
  const target = horizontal ? { scaleX: 1 } : { scaleY: 1 };
  const motionProps =
    trigger === "mount"
      ? { initial, animate: reduced ? undefined : target }
      : {
          initial,
          whileInView: reduced ? undefined : target,
          viewport: HUD_VIEWPORT,
        };
  return (
    <Motion.span
      className={className}
      style={{
        ...chapterBarStyle(hue, height, top, left, width, orientation),
        ...style,
      }}
      {...motionProps}
      transition={{ duration: 0.5, delay, ease: [0.16, 1, 0.3, 1] }}
      aria-hidden
    />
  );
}

/* --- CornerBrackets — 4 HUD L brackets ------------------------------- */

const CORNER_DELAYS = { tl: 0, tr: 0.05, bl: 0.1, br: 0.15 } as const;
type Corner = keyof typeof CORNER_DELAYS;

interface CornerBracketsProps {
  inset?: number;
  size?: number;
  opacity?: number;
  hue?: number | null;
  animate?: boolean;
  show?: boolean;
}

export function CornerBrackets({
  inset = 6,
  size = 8,
  opacity = 0.28,
  hue = null,
  animate: shouldAnimate = true,
  show = true,
}: CornerBracketsProps) {
  const reduced = useReducedMotion();
  const stroke =
    hue != null
      ? `oklch(62% 0.19 ${hue} / ${opacity * 2})`
      : `rgba(235,235,245,${opacity})`;
  const corner = (pos: Corner) => {
    const style: CSSProperties = {
      position: "absolute",
      width: size,
      height: size,
      pointerEvents: "none",
    };
    if (pos === "tl") {
      style.top = inset;
      style.left = inset;
    }
    if (pos === "tr") {
      style.top = inset;
      style.right = inset;
      style.transform = "scaleX(-1)";
    }
    if (pos === "bl") {
      style.bottom = inset;
      style.left = inset;
      style.transform = "scaleY(-1)";
    }
    if (pos === "br") {
      style.bottom = inset;
      style.right = inset;
      style.transform = "scale(-1,-1)";
    }
    const animateProps =
      shouldAnimate && !reduced
        ? {
            initial: { opacity: 0 },
            animate: { opacity: show ? 1 : 0 },
            transition: { duration: 0.2, delay: CORNER_DELAYS[pos] },
          }
        : { initial: false as const, animate: { opacity: show ? 1 : 0 } };
    return (
      <Motion.svg
        key={pos}
        style={style}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        {...animateProps}
      >
        <path
          d={`M 0 ${size} L 0 0 L ${size} 0`}
          stroke={stroke}
          strokeWidth="1"
          fill="none"
        />
      </Motion.svg>
    );
  };
  return (
    <>{(["tl", "tr", "bl", "br"] as Corner[]).map(corner)}</>
  );
}
