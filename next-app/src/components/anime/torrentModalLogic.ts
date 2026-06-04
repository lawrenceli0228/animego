// Pure logic extracted from TorrentModal.tsx so it's unit-testable in
// isolation — next-app tests lib-style modules, not components. The
// component imports these back; behaviour is unchanged by the extraction.

/** Resolution (uppercased) + codec/source tags parsed out of a release title. */
export function parseTags(title: string): { resolution: string | null; tags: string[] } {
  const res =
    title.match(/\b(4K|2160[Pp]|1080[Pp]|720[Pp]|480[Pp])\b/)?.[1]?.toUpperCase() ?? null;
  const codec = title.match(/\b(HEVC|AVC|x265|x264|H\.?265|H\.?264)\b/i)?.[1] ?? null;
  const source = title.match(/\b(WEB-?DL|WebRip|BDRip|Blu-?[Rr]ay)\b/i)?.[1] ?? null;
  return { resolution: res, tags: [codec, source].filter((t): t is string => Boolean(t)) };
}

/** YYYY/MM/DD, or "" for null / unparseable input. */
export function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

// Score 1 if title contains this specific episode number (common patterns).
// Mirrors legacy epRelevance in client/src/components/anime/TorrentModal.jsx
// so sort / filter behaviour matches across the two surfaces.
export function epRelevance(title: string, epPad: string): number {
  const epNum = String(parseInt(epPad, 10));
  const patterns = [
    `- ${epPad}`,
    `- ${epNum} `,
    `- ${epNum}]`,
    `- ${epNum}.`,
    `[${epPad}]`,
    `[${epNum}]`,
    ` ${epPad} `,
    ` ${epPad}.`,
  ];
  return patterns.some((p) => title.includes(p)) ? 1 : 0;
}

// Health-coded seed colour: green for well-seeded, amber for thin, muted
// for dead/zero. `seeders` is normalised to a number by the caller (null/
// undefined "unknown" rows are handled before this runs).
export function seederColor(seeders: number): string {
  if (seeders >= 20) return "#34d399";
  if (seeders > 0) return "#f5a623";
  return "rgba(235,235,245,0.30)";
}

// The torrents request derived from the modal's two modes:
//   - manualQ === null   → primary path: query by anilistId (go-api expands
//     the title variants, pulls the AnimeTosho aid feed, dedups, sorts).
//   - manualQ is a string → keyword override (search box / title pill).
// An empty/whitespace manual query is a no-op (skip=true) — nothing to fetch.
// cacheKey namespaces the two modes (`id:<n>` vs `q:<kw>`) so an anilistId
// result and a keyword result never collide in the module cache.
export function buildTorrentRequest(
  anilistId: number,
  manualQ: string | null,
): { skip: boolean; path: string; cacheKey: string } {
  const isManual = manualQ !== null;
  const term = manualQ?.trim() ?? "";

  if (isManual && !term) {
    return { skip: true, path: "", cacheKey: "" };
  }
  if (isManual) {
    return {
      skip: false,
      path: `/api/anime/torrents?q=${encodeURIComponent(term)}`,
      cacheKey: `q:${term.toLowerCase()}`,
    };
  }
  return {
    skip: false,
    path: `/api/anime/torrents?anilistId=${anilistId}`,
    cacheKey: `id:${anilistId}`,
  };
}
