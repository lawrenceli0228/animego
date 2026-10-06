// Splitting a hero title into the pieces that fade in one after another.
//
// Each token renders as an inline-block, and a line can break between any two
// of them. That makes this function the title's line-breaking policy:
//
//   - A CJK character is its own token. CJK text breaks between any two
//     characters anyway, so nothing is lost and each glyph gets its own beat.
//   - A run of Latin letters, digits and in-word punctuation is ONE token.
//     Split into letters, "SHELL" could wrap as "SHE / LL".
//   - Whitespace becomes a single no-break space in its own token. A plain
//     space alone inside an inline-block collapses to zero width, which would
//     glue "THE" and "GHOST" together.
//
// Pure: no DOM, no React.

export const NBSP = " ";

// Latin-script letters (accents included), decimal digits, and the ASCII
// punctuation that lives inside a word: "Re:ZERO", "Dr.STONE", "Rock'n",
// "Q&A", "Sword-Art".
const TOKEN = /[\p{Script=Latin}\p{Nd}:.'!?&\-]+|\s+|./gsu;

export function titleTokens(title: string): string[] {
  const trimmed = title.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  for (const match of trimmed.matchAll(TOKEN)) {
    out.push(/^\s+$/u.test(match[0]) ? NBSP : match[0]);
  }
  return out;
}

/** Per-token stagger, in the design's rhythm (26ms apart). */
const STAGGER_MS = 26;
/** When a user switches slides: starts after the banner has begun to move. */
const SWITCH_START_MS = 160;
const SWITCH_CAP_MS = 900;
/** On first paint: waits for the hero's own entrance to get under way. */
const ENTRY_START_MS = 420;
const ENTRY_CAP_MS = 1200;

export interface TokenDelays {
  /** Transition delay when this slide becomes the active one. */
  switchMs: number;
  /** Animation delay for the page's first paint. */
  entryMs: number;
}

export function tokenDelays(index: number): TokenDelays {
  return {
    switchMs: Math.min(SWITCH_START_MS + index * STAGGER_MS, SWITCH_CAP_MS),
    entryMs: Math.min(ENTRY_START_MS + index * STAGGER_MS, ENTRY_CAP_MS),
  };
}
