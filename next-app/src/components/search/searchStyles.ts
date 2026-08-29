// The inline style objects for /search.
//
// Split out of SearchExperience so that file reads as behaviour: the whole
// point of the change that created it is the timing of a request, and that
// argument is hard to follow past 180 lines of padding and border colour.
// Inline objects rather than a CSS module because that is what this route has
// always used; the handful of things inline style cannot express
// (:focus-visible, the responsive grid) stay in the component's <style> block.

import type { CSSProperties } from "react";

export const headingStyle: CSSProperties = {
  fontSize: "clamp(22px,3vw,34px)",
  marginBottom: 24,
  background: "linear-gradient(135deg,#ffffff,rgba(235,235,245,0.60))",
  WebkitBackgroundClip: "text",
  WebkitTextFillColor: "transparent",
  fontFamily: "var(--font-display)",
  fontWeight: 700,
};

export const formStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
  marginBottom: 20,
  alignItems: "center",
};

export const inputWrapStyle: CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 240,
  maxWidth: 480,
};

export const iconStyle: CSSProperties = {
  position: "absolute",
  left: 16,
  top: "50%",
  transform: "translateY(-50%)",
  color: "rgba(235,235,245,0.30)",
  fontSize: 16,
  pointerEvents: "none",
};

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "12px 16px 12px 44px",
  borderRadius: 9999,
  border: "1px solid #38383a",
  background: "#2c2c2e",
  color: "#ffffff",
  fontSize: 14,
  transition: "border-color 0.2s, box-shadow 0.2s",
};

export const submitStyle: CSSProperties = {
  padding: "10px 20px",
  borderRadius: 9999,
  border: "1px solid rgba(10,132,255,0.5)",
  background: "rgba(10,132,255,0.12)",
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "var(--font-display)",
};

export const statusStyle: CSSProperties = {
  color: "rgba(235,235,245,0.45)",
  fontSize: 12,
  fontFamily: "var(--font-display)",
  minWidth: 56,
};

export const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginBottom: 16,
};

export const chipStyle = (active: boolean): CSSProperties => ({
  padding: "4px 10px",
  borderRadius: 9999,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  transition: "all 0.2s",
  background: active ? "rgba(10,132,255,0.12)" : "rgba(120,120,128,0.12)",
  border: `1px solid ${active ? "rgba(10,132,255,0.5)" : "transparent"}`,
  color: active ? "#0a84ff" : "rgba(235,235,245,0.60)",
  fontFamily: "var(--font-display)",
});

export const promptStyle: CSSProperties = {
  textAlign: "center",
  padding: "60px 0",
  color: "rgba(235,235,245,0.30)",
  fontFamily: "var(--font-display)",
  fontSize: 15,
};

export const errorStyle: CSSProperties = {
  textAlign: "center",
  padding: "60px 0",
  color: "#ff453a",
  fontFamily: "var(--font-display)",
  fontSize: 14,
};

export const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, 1fr)",
  gap: 12,
};

export const paginationWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  padding: "32px 0",
};

export const pageButtonStyle = (disabled: boolean): CSSProperties => ({
  padding: "8px 20px",
  borderRadius: 8,
  border: `1px solid ${disabled ? "rgba(84,84,88,0.30)" : "rgba(84,84,88,0.65)"}`,
  color: disabled ? "rgba(235,235,245,0.18)" : "#ffffff",
  background: disabled ? "transparent" : "rgba(120,120,128,0.12)",
  cursor: disabled ? "not-allowed" : "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  fontWeight: 500,
  textDecoration: "none",
  display: "inline-block",
});

export const pageInfoStyle: CSSProperties = {
  color: "rgba(235,235,245,0.60)",
  fontSize: 14,
  fontFamily: "var(--font-display)",
};
