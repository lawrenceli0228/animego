import type { CSSProperties, ReactNode } from "react";

// Shared chrome + prose styling for the static legal pages (/privacy,
// /terms, /copyright). Owns layout + typography only so the three
// documents stay visually consistent; the legal copy lives in each page.

const wrap: CSSProperties = {
  maxWidth: 820,
  margin: "0 auto",
  padding: "56px 24px 96px",
  color: "rgba(235,235,245,0.82)",
  fontSize: 15,
  lineHeight: 1.8,
};
const titleStyle: CSSProperties = {
  fontFamily: "'Sora', sans-serif",
  fontSize: 28,
  fontWeight: 700,
  color: "#fff",
  marginBottom: 8,
  lineHeight: 1.25,
};
const updatedStyle: CSSProperties = {
  fontSize: 13,
  color: "rgba(235,235,245,0.40)",
  marginBottom: 36,
};

// Prose tokens reused by every legal page so headings/lists/links match.
export const legalStyles = {
  h2: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 18,
    fontWeight: 600,
    color: "#fff",
    margin: "36px 0 12px",
  } as CSSProperties,
  p: { margin: "0 0 14px" } as CSSProperties,
  ul: { margin: "0 0 14px", paddingLeft: 22 } as CSSProperties,
  li: { margin: "0 0 7px" } as CSSProperties,
  a: { color: "#0a84ff", textDecoration: "none" } as CSSProperties,
  strong: { color: "#fff", fontWeight: 600 } as CSSProperties,
};

export default function LegalDoc({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <main style={wrap}>
      <h1 style={titleStyle}>{title}</h1>
      <p style={updatedStyle}>{updated}</p>
      {children}
    </main>
  );
}
