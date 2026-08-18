import Link from "@/components/ui/LocaleLink";
import { ApiError, apiGet } from "@/lib/api";
import { pickTitle } from "@/lib/formatters";
import FadeImage from "@/components/ui/FadeImage";
import type { Dict, Lang } from "@/lib/i18n";
import type { WatchingItem } from "@/lib/types";
import { currentSeasonHref, resolveWatchingView } from "./continueWatchingState";
import WatchingEmptySwap from "./WatchingEmptySwap";
import SignedOutGate from "./SignedOutGate";

// RSC ContinueWatching. Server-side tries
// `/api/subscriptions?status=watching` and renders one of three bodies:
//   - anonymous (401/network)  → blurred stub + login CTA
//   - authed, zero rows        → same blurred stub + "add something" CTA
//   - authed, rows             → the real grid
//
// The zero-row case used to `return null` (a straight port of legacy
// ContinueWatching.jsx's `if (!user || !list?.length) return null`), which
// made registering *subtract* from the homepage: the anonymous visitor saw a
// section explaining what tracking is, and the account they just created saw
// nothing at all. Same-shaped stub with different copy keeps the section a
// constant, so the only thing signing up changes is which call to action it
// carries.
//
// The zero-row body is additionally wrapped in WatchingEmptySwap, the one
// client boundary in this file: its copy is the only thing on the page a
// visitor can falsify without navigating (press + in the trending grid above
// and "you're not tracking anything" is instantly wrong). The swap stays a
// leaf — this component remains a Server Component and both bodies are
// rendered here, on the server.
//
// Cookie forwarding via lib/api.ts buildHeaders() — same path the
// ActivityFeed sibling uses. Both rely on P8.1 cookie dual-track
// (commit cc073f9).

interface ContinueWatchingProps {
  dict: Dict;
  lang: Lang;
}

const PLACEHOLDER_COUNT = 4;

const sectionStyle = { marginTop: 40 } as const;

const headerStyle = { marginBottom: 16 } as const;

const labelStyle = {
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: "2px",
  textTransform: "uppercase" as const,
  marginBottom: 8,
} as const;

const titleStyle = {
  fontSize: "clamp(22px,3vw,32px)",
  color: "#ffffff",
} as const;

const wrapStyle = {
  position: "relative" as const,
  borderRadius: 12,
  overflow: "hidden",
  minHeight: 240,
} as const;

const stubGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: 16,
  filter: "blur(2px)",
  opacity: 0.55,
  pointerEvents: "none" as const,
} as const;

const placeholderCardStyle = {
  aspectRatio: "3/4",
  borderRadius: 12,
  background:
    "linear-gradient(180deg, rgba(120,120,128,0.18) 0%, rgba(28,28,30,0.95) 100%)",
  border: "1px solid #38383a",
} as const;

const overlayStyle = {
  position: "absolute" as const,
  inset: 0,
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  textAlign: "center" as const,
  background:
    "radial-gradient(ellipse at center, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 70%, transparent 100%)",
  padding: "24px 16px",
} as const;

// Title + body sit closer to each other than either does to the CTA, so they
// read as one block instead of three evenly-spaced lines.
const overlayTextStyle = {
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  gap: 6,
} as const;

const overlayTitleStyle = {
  fontFamily: "'Sora',sans-serif",
  color: "#ffffff",
  fontSize: 17,
  fontWeight: 600,
  maxWidth: 360,
  lineHeight: 1.35,
} as const;

const overlayCopyStyle = {
  color: "rgba(235,235,245,0.85)",
  fontSize: 14,
  fontWeight: 500,
  maxWidth: 360,
  lineHeight: 1.5,
} as const;

const ctaStyle = {
  display: "inline-block",
  padding: "10px 22px",
  borderRadius: 8,
  background: "#0a84ff",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
  letterSpacing: "0.5px",
} as const;

const realGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: 16,
} as const;

const cardLinkStyle = {
  textDecoration: "none",
  color: "inherit",
  borderRadius: 12,
  overflow: "hidden",
  display: "block",
} as const;

const cardInnerStyle = {
  position: "relative" as const,
} as const;

const cardImgStyle = {
  width: "100%",
  aspectRatio: "3/4",
  objectFit: "cover" as const,
  display: "block",
  background: "#2c2c2e",
} as const;

const epBadgeStyle = {
  position: "absolute" as const,
  top: 6,
  right: 6,
  background: "rgba(0,0,0,0.75)",
  backdropFilter: "blur(4px)",
  borderRadius: 6,
  padding: "2px 6px",
  fontSize: 11,
  fontWeight: 600,
  color: "#0a84ff",
} as const;

const cardOverlayStyle = {
  position: "absolute" as const,
  bottom: 0,
  left: 0,
  right: 0,
  padding: "24px 8px 6px",
  background:
    "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)",
} as const;

const cardTitleStyle = {
  fontFamily: "'Sora',sans-serif",
  fontSize: 12,
  fontWeight: 600,
  color: "#ffffff",
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical" as const,
  lineHeight: 1.35,
  marginBottom: 5,
  textShadow: "0 1px 3px rgba(0,0,0,0.5)",
} as const;

const progressTrackStyle = {
  height: 3,
  borderRadius: 1.5,
  background: "rgba(255,255,255,0.15)",
} as const;

function progressFillStyle(currentEpisode: number, episodes: number | null) {
  const pct = episodes && episodes > 0
    ? Math.min(100, (currentEpisode / episodes) * 100)
    : 0;
  return {
    height: "100%",
    borderRadius: 1.5,
    width: `${pct}%`,
    background: "#0a84ff",
  } as const;
}

function badgeText(item: WatchingItem, dict: Dict, lang: Lang): string {
  const epUnit = dict.detail.epUnit;
  if (item.currentEpisode > 0) {
    if (item.episodes && item.episodes > 0) {
      return `${item.currentEpisode}/${item.episodes} ${epUnit}`;
    }
    return `${item.currentEpisode} ${epUnit}`;
  }
  if (item.episodes && item.episodes > 0) {
    return `${item.episodes} ${epUnit}`;
  }
  return lang === "zh" ? "在追" : "Watching";
}

/**
 * Blurred placeholder cards behind a centred pitch + one CTA. Shared by both
 * empty states so the anonymous and the zero-subscription homepage differ in
 * copy only — the section never changes shape under the user.
 */
function StubSection({
  dict,
  title,
  body,
  ctaHref,
  ctaLabel,
  ctaAria,
}: {
  dict: Dict;
  /** Omitted by the logged-out stub, which is a single line of copy. */
  title?: string;
  body: string;
  ctaHref: string;
  ctaLabel: string;
  ctaAria?: string;
}) {
  return (
    <section style={sectionStyle} aria-label={dict.home.watchingTitle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.home.continueLabel}</p>
        <h2 style={titleStyle}>{dict.home.watchingTitle}</h2>
      </div>
      <div style={wrapStyle}>
        <div style={stubGridStyle} aria-hidden="true">
          {Array.from({ length: PLACEHOLDER_COUNT }).map((_, i) => (
            <div key={i} style={placeholderCardStyle} />
          ))}
        </div>
        <div style={overlayStyle}>
          <div style={overlayTextStyle}>
            {title ? <p style={overlayTitleStyle}>{title}</p> : null}
            <p style={overlayCopyStyle}>{body}</p>
          </div>
          <Link href={ctaHref} aria-label={ctaAria} style={ctaStyle}>
            {ctaLabel}
          </Link>
        </div>
      </div>
    </section>
  );
}

function LoggedOutStub({ dict, lang }: ContinueWatchingProps) {
  const copy =
    lang === "zh"
      ? "登录后追番进度会出现在这里"
      : "Login to track your watching progress";
  return (
    <StubSection
      dict={dict}
      body={copy}
      ctaHref="/login"
      ctaLabel={dict.nav.login}
      ctaAria={lang === "zh" ? "登录 AnimeGoClub" : "Login to AnimeGoClub"}
    />
  );
}

/**
 * Logged in, nothing tracked yet. The CTA has to be *this season* rather than
 * the homepage the user is already standing on — the failure it fixes is "I
 * signed up and now what", so it must hand over a place to press +.
 */
function ZeroSubscriptionStub({ dict }: { dict: Dict }) {
  return (
    <StubSection
      dict={dict}
      title={dict.home.watchingEmptyTitle}
      body={dict.home.watchingEmptyBody}
      ctaHref={currentSeasonHref()}
      ctaLabel={dict.home.watchingEmptyCta}
    />
  );
}

/**
 * What the empty stub becomes the instant a + lands elsewhere on the page.
 *
 * Same shape, three swapped strings — the section must not resize under the
 * user for a copy change. The body line survives verbatim because it is an
 * instruction ("tap + on any poster") and stays true after the first add; the
 * only sentence that turns into a lie is the title, so only the title (and
 * the CTA, which now has somewhere better to point) changes.
 */
function JustAddedStub({ dict }: { dict: Dict }) {
  return (
    <StubSection
      dict={dict}
      title={dict.sub.toastAdded}
      body={dict.home.watchingEmptyBody}
      ctaHref="/profile"
      ctaLabel={dict.sub.toastViewList}
    />
  );
}

function WatchingGrid({
  items,
  dict,
  lang,
}: {
  items: WatchingItem[];
  dict: Dict;
  lang: Lang;
}) {
  return (
    <section style={sectionStyle} aria-label={dict.home.watchingTitle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.home.continueLabel}</p>
        <h2 style={titleStyle}>{dict.home.watchingTitle}</h2>
      </div>
      <div style={realGridStyle}>
        {items.map((item) => (
          <Link
            key={item.anilistId}
            href={`/anime/${item.anilistId}`}
            style={cardLinkStyle}
          >
            <div style={cardInnerStyle}>
              {item.coverImageUrl ? (
                <FadeImage
                  src={item.coverImageUrl}
                  alt={pickTitle(item, lang)}
                  style={cardImgStyle}
                />
              ) : (
                <div style={{ ...cardImgStyle, background: "#2c2c2e" }} />
              )}
              <div style={epBadgeStyle}>{badgeText(item, dict, lang)}</div>
              <div style={cardOverlayStyle}>
                <div style={cardTitleStyle}>{pickTitle(item, lang)}</div>
                {item.episodes && item.episodes > 0 ? (
                  <div style={progressTrackStyle}>
                    <div
                      style={progressFillStyle(item.currentEpisode, item.episodes)}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default async function ContinueWatching({
  dict,
  lang,
}: ContinueWatchingProps) {
  let items: WatchingItem[] = [];
  let loggedOut = false;
  try {
    items = await apiGet<WatchingItem[]>(
      "/api/subscriptions?status=watching",
      { cache: "no-store" },
    );
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      loggedOut = true;
    } else {
      loggedOut = true;
    }
  }

  switch (resolveWatchingView(loggedOut, items.length)) {
    case "logged-out":
      return <LoggedOutStub dict={dict} lang={lang} />;
    case "empty":
      // The one view that can be contradicted by something the visitor does
      // on this very screen — see WatchingEmptySwap. Both bodies are rendered
      // here on the server; the client only picks between them.
      //
      // SignedOutGate wraps it for the same reason it wraps the grid below:
      // logout does not navigate, so without it this block would keep telling
      // a signed-out visitor what to do with an account they no longer hold.
      return (
        <SignedOutGate signedOut={<LoggedOutStub dict={dict} lang={lang} />}>
          <WatchingEmptySwap filled={<JustAddedStub dict={dict} />}>
            <ZeroSubscriptionStub dict={dict} />
          </WatchingEmptySwap>
        </SignedOutGate>
      );
    default:
      // The grid is the biggest account-specific surface on the home page —
      // covers, titles and per-series episode progress. Logout leaves the
      // page in place, so it needs an explicit teardown or a shared machine
      // shows the previous user's watch list under a "Log in" navbar.
      return (
        <SignedOutGate signedOut={<LoggedOutStub dict={dict} lang={lang} />}>
          <WatchingGrid items={items} dict={dict} lang={lang} />
        </SignedOutGate>
      );
  }
}
