// RSC port of legacy WatchersAvatarList.jsx.
//
// Server-side fetches `/api/anime/:id/watchers?limit=8`. The Go API
// returns the bare envelope `{data, total}` (not unwrapped) — see
// apiGetEnvelope. Anonymous viewers see whatever the public endpoint
// returns, which today is the same list as logged-in viewers (no auth
// gate at the Go handler for this surface). 401 / network errors
// silently render nothing — the row is decorative.
//
// Visual contract preserved from legacy: avatar circles with the
// first-letter glyph and a deterministic accent color, overlapped via
// negative margin, counter beside them. Click target on each avatar
// is a /u/:username link (not yet ported to next-app, but the legacy
// route handles the redirect for now).

import Link from "@/components/ui/LocaleLink";
import { ApiError, apiGetEnvelope } from "@/lib/api";
import { getDictByLang } from "@/lib/i18n";
import { type Lang } from "@/lib/i18n/lang";
import { DEFAULT_CARD_IMAGE } from "@/lib/cardDefaults";
import { isMaskedUsername } from "@/lib/publicUsername";
import FallbackImg from "@/components/ui/FallbackImg";
import type { WatcherItem, WatchersResponse } from "@/lib/types";

interface WatchersAvatarListProps {
  anilistId: number;
  /**
   * The rendering language, from the caller's `[lang]` route param.
   *
   * A prop rather than a lookup: this is a Server Component under
   * src/components/, so it sits outside the route tree and has no params of
   * its own to read. It previously called getLang(), which answered "zh" for
   * every render regardless of the URL.
   */
  lang: Lang;
}

const AVATAR_LIMIT = 8;
const COLORS = [
  "#0a84ff",
  "#5ac8fa",
  "#30d158",
  "#ff9f0a",
  "#ff453a",
  "#bf5af2",
];

function avatarColor(username: string): string {
  return COLORS[username.charCodeAt(0) % COLORS.length];
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 10,
  marginBottom: 8,
} as const;

const avatarsStyle = {
  display: "flex",
} as const;

const avatarStyle = {
  width: 28,
  height: 28,
  borderRadius: "50%",
  border: "2px solid #000000",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  fontWeight: 700,
  color: "#fff",
  textTransform: "uppercase" as const,
  flexShrink: 0,
  textDecoration: "none",
} as const;

const counterStyle = {
  fontSize: 12,
  color: "rgba(235,235,245,0.60)",
} as const;

const moreStyle = {
  color: "#0a84ff",
  marginLeft: 4,
} as const;

export default async function WatchersAvatarList({
  anilistId,
  lang,
}: WatchersAvatarListProps) {
  let watchers: WatcherItem[] = [];
  let total = 0;
  try {
    const env = await apiGetEnvelope<WatchersResponse>(
      `/api/anime/${anilistId}/watchers?limit=${AVATAR_LIMIT}`,
      // ISR-safe: public "who's watching" data (no auth gate at the Go
      // handler), so `auth: false` skips the cookies()/headers() read that
      // would force the detail page dynamic. 60s window matches the page.
      { revalidate: 60, auth: false },
    );
    watchers = Array.isArray(env.data) ? env.data : [];
    total = typeof env.total === "number" ? env.total : watchers.length;
  } catch (err) {
    // 401, network, parse errors — render nothing. This is a decorative
    // row and the rest of the detail page must still render.
    if (!(err instanceof ApiError)) throw err;
  }

  if (total === 0 || watchers.length === 0) return null;

  const dict = getDictByLang(lang);
  const more = Math.max(0, total - watchers.length);
  // dict typing leaks `anime` since en.ts omits some optional fields;
  // narrow to a record so the lookup compiles in both langs.
  const animeDict = dict.anime as unknown as Record<string, string>;
  const watchersLabel = animeDict.watchers ?? "watching";
  const moreLabel = animeDict.watchersMore ?? "+";
  // Users whose username looked like a contact detail come back from the API
  // as an opaque handle. Explain the placeholder on hover rather than letting
  // it read as a broken name — see lib/publicUsername.ts.
  const maskedLabel = animeDict.maskedUser ?? "This user hasn't set a public display name yet";

  return (
    <div style={rowStyle}>
      <div style={avatarsStyle}>
        {watchers.map((w, i) => {
          const overlap = i < watchers.length - 1 ? { marginRight: -8 } : {};
          const stack = { zIndex: watchers.length - i };
          const masked = isMaskedUsername(w.username);
          // The handle still identifies the row and still routes, so it stays
          // the visible label; the hover text is what explains it.
          const hoverText = masked ? `${w.username} — ${maskedLabel}` : w.username;
          return (
            <Link
              key={w.username}
              href={`/u/${encodeURIComponent(w.username)}`}
              title={hoverText}
              aria-label={hoverText}
              prefetch={false}
              style={{
                ...avatarStyle,
                ...overlap,
                ...stack,
                background: avatarColor(w.username),
                position: "relative",
                overflow: "hidden",
              }}
            >
              <FallbackImg
                src={w.avatarUrl ?? w.backdropCoverUrl ?? DEFAULT_CARD_IMAGE}
                fallback={DEFAULT_CARD_IMAGE}
                alt={w.username}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </Link>
          );
        })}
      </div>
      <span style={counterStyle}>
        {`${total} ${watchersLabel}`}
        {more > 0 && (
          <span style={moreStyle}>
            {lang === "zh" ? `（${moreLabel} ${more} 人）` : ` (${moreLabel}${more} more)`}
          </span>
        )}
      </span>
    </div>
  );
}
