"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CSSProperties, FormEvent } from "react";
import type { Dict } from "@/lib/i18n";

// Single source of truth for genre chips. Mirrors the legacy
// client/src/utils/constants.js GENRES array byte-for-byte so /search
// behaves identically across the Vite SPA and the Next 16 RSC port.
const GENRES = [
  "Action",
  "Adventure",
  "Comedy",
  "Drama",
  "Ecchi",
  "Fantasy",
  "Horror",
  "Mahou Shoujo",
  "Mecha",
  "Music",
  "Mystery",
  "Psychological",
  "Romance",
  "Sci-Fi",
  "Slice of Life",
  "Sports",
  "Supernatural",
  "Thriller",
] as const;

// Debounce window for the search input. Matches the legacy SearchBar
// (client/src/components/search/SearchBar.jsx:11) at 400ms so the
// perceived "type-then-pause" feel is unchanged. Genre clicks bypass
// the debounce and push immediately -- a chip toggle is intentional.
const DEBOUNCE_MS = 400;

interface SearchFiltersProps {
  initialQ: string;
  initialGenre: string;
  dict: Dict;
}

// Build the next /search URL from q + genre, dropping empty params so
// the resulting query string stays clean (no "?q=&genre=").
function buildSearchUrl(q: string, genre: string): string {
  const params = new URLSearchParams();
  const trimmedQ = q.trim();
  if (trimmedQ) params.set("q", trimmedQ);
  if (genre) params.set("genre", genre);
  const qs = params.toString();
  return qs ? `/search?${qs}` : "/search";
}

const formStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
  marginBottom: 20,
  alignItems: "center",
};

const inputWrapStyle: CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 240,
  maxWidth: 480,
};

const iconStyle: CSSProperties = {
  position: "absolute",
  left: 16,
  top: "50%",
  transform: "translateY(-50%)",
  color: "rgba(235,235,245,0.30)",
  fontSize: 16,
  pointerEvents: "none",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "12px 16px 12px 44px",
  borderRadius: 9999,
  border: "1px solid #38383a",
  background: "#2c2c2e",
  color: "#ffffff",
  fontSize: 14,
  outline: "none",
  transition: "border-color 0.2s, box-shadow 0.2s",
};

const submitStyle: CSSProperties = {
  padding: "10px 20px",
  borderRadius: 9999,
  border: "1px solid rgba(10,132,255,0.5)",
  background: "rgba(10,132,255,0.12)",
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "'Sora', sans-serif",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginBottom: 16,
};

const chipStyle = (active: boolean): CSSProperties => ({
  padding: "4px 10px",
  borderRadius: 9999,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  transition: "all 0.2s",
  background: active ? "rgba(10,132,255,0.12)" : "rgba(120,120,128,0.12)",
  border: `1px solid ${active ? "rgba(10,132,255,0.5)" : "transparent"}`,
  color: active ? "#0a84ff" : "rgba(235,235,245,0.60)",
  fontFamily: "'Sora', sans-serif",
});

export default function SearchFilters({
  initialQ,
  initialGenre,
  dict,
}: SearchFiltersProps) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const [genre, setGenre] = useState(initialGenre);

  // Sync local state when server-provided initials change (e.g. user
  // hits back/forward, or a chip click re-renders via router.push).
  // Without this, the input visually drifts from the URL.
  useEffect(() => {
    setQ(initialQ);
  }, [initialQ]);
  useEffect(() => {
    setGenre(initialGenre);
  }, [initialGenre]);

  // Debounced auto-push so "type, pause, results" matches the legacy
  // SearchBar UX without firing a router.push on every keystroke. The
  // first effect mount is a no-op (q matches initialQ) thanks to the
  // ref guard, so opening /search?q=frieren does not trigger a redundant
  // navigation back to the same URL.
  const skipDebounceRef = useRef(true);
  useEffect(() => {
    if (skipDebounceRef.current) {
      skipDebounceRef.current = false;
      return;
    }
    if (q === initialQ) return;
    const timer = setTimeout(() => {
      router.push(buildSearchUrl(q, genre));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, genre, initialQ, router]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    router.push(buildSearchUrl(q, genre));
  };

  const onGenreClick = (g: string) => {
    const next = genre === g ? "" : g;
    setGenre(next);
    // Genre toggles bypass debounce -- a chip click is a deliberate
    // filter action, the user wants the result immediately.
    router.push(buildSearchUrl(q, next));
  };

  return (
    <>
      <form style={formStyle} onSubmit={onSubmit} role="search">
        <div style={inputWrapStyle}>
          <span style={iconStyle} aria-hidden>
            #
          </span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={dict.search.placeholder}
            aria-label={dict.search.title}
            style={inputStyle}
            onFocus={(e) => {
              e.target.style.borderColor = "#0a84ff";
              e.target.style.boxShadow = "0 0 0 3px rgba(10,132,255,0.25)";
            }}
            onBlur={(e) => {
              e.target.style.borderColor = "#38383a";
              e.target.style.boxShadow = "none";
            }}
          />
        </div>
        <button type="submit" style={submitStyle}>
          {dict.nav.search}
        </button>
      </form>
      <div style={chipRowStyle} role="group" aria-label="genre filter">
        {GENRES.map((g) => {
          const active = genre === g;
          return (
            <button
              key={g}
              type="button"
              onClick={() => onGenreClick(g)}
              style={chipStyle(active)}
              aria-pressed={active}
            >
              {g}
            </button>
          );
        })}
      </div>
    </>
  );
}
