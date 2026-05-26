// P9 — shared inline styles for the four auth form surfaces (/login,
// /register, /forgot-password, /reset-password/[token]).
//
// Why a single source: at four callers the duplication threshold is
// real. Any visual change (card background, border radius, focus
// glow) must land in every form simultaneously, and the inline-style
// objects had drifted to within a comma of each other across copies.
// Pull the base into one module, let each form layer its variant
// pieces locally (login's forgot-password row, forgot-password's
// "sent" view glyph + message).
//
// CSSProperties typing matches the project-wide convention for inline
// styles (see Navbar.tsx). Two of the entries are callbacks because
// they depend on per-render state (focused field, busy state).

import type { CSSProperties } from "react";

export const authFormStyles = {
  shell: {
    minHeight: "calc(100vh - 56px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
  } as CSSProperties,
  card: {
    width: "100%",
    maxWidth: 420,
    background: "#1c1c1e",
    border: "1px solid #38383a",
    borderRadius: 16,
    padding: 40,
    boxShadow: "0 16px 48px rgba(0,0,0,0.60)",
  } as CSSProperties,
  header: { textAlign: "center", marginBottom: 32 } as CSSProperties,
  title: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 28,
    color: "#ffffff",
    marginBottom: 8,
  } as CSSProperties,
  subtitle: {
    color: "rgba(235,235,245,0.60)",
    fontSize: 14,
  } as CSSProperties,
  label: {
    display: "block",
    fontSize: 13,
    fontWeight: 600,
    color: "rgba(235,235,245,0.60)",
    marginBottom: 6,
  } as CSSProperties,
  input: (focused: boolean): CSSProperties => ({
    width: "100%",
    padding: "12px 16px",
    borderRadius: 8,
    background: "#2c2c2e",
    border: `1px solid ${focused ? "#0a84ff" : "#38383a"}`,
    boxShadow: focused ? "0 0 0 3px rgba(10,132,255,0.25)" : "none",
    color: "#ffffff",
    fontSize: 14,
    outline: "none",
    marginBottom: 16,
    transition: "border-color 0.2s, box-shadow 0.2s",
    boxSizing: "border-box",
  }),
  error: {
    color: "#ff453a",
    fontSize: 13,
    marginBottom: 12,
    textAlign: "center",
    minHeight: 18,
  } as CSSProperties,
  submit: (busy: boolean): CSSProperties => ({
    width: "100%",
    padding: 12,
    background: "#0a84ff",
    border: "none",
    borderRadius: 10,
    color: "#fff",
    fontSize: 15,
    fontWeight: 700,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "'Sora', sans-serif",
    opacity: busy ? 0.7 : 1,
    transition: "opacity 0.15s",
  }),
  footer: {
    textAlign: "center",
    marginTop: 20,
    fontSize: 14,
    color: "rgba(235,235,245,0.55)",
  } as CSSProperties,
  footerLink: {
    color: "#0a84ff",
    fontWeight: 600,
    textDecoration: "none",
  } as CSSProperties,
} as const;
