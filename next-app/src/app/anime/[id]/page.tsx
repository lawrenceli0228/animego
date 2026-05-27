// Phase 5.A: /anime/[id] detail RSC + ISR (60s).
//
// Design notes (vs legacy AnimeDetailPage.jsx):
//   - SEO-critical surfaces only (hero + relations + characters + staff +
//     recommendations). Subscription / Watchers / EpisodeList / TorrentModal
//     / PlayButton are interactive and ride client routes in Phase 6.
//   - JSON-LD TVSeries schema injected for Google Rich Results
//     (plan Phase 5 acceptance gate).
//   - No 'use client': every block here is static markup; the read-more
//     toggle and accent-cache writes from the legacy hero do NOT belong on
//     a server-rendered SEO surface (they're client niceties).
//   - generateMetadata reuses the same apiGet so Next memoizes the fetch
//     within the request; no double load on the Go API.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import AnimeCard from "@/components/anime/AnimeCard";
import DescriptionExpand from "@/components/anime/DescriptionExpand";
import DetailActions from "@/components/anime/DetailActions";
import WatchersAvatarList from "@/components/anime/WatchersAvatarList";
import { apiGet, ApiError } from "@/lib/api";
import {
  formatFuzzyDate,
  formatScore,
  pickCharacterName,
  pickStaffName,
  pickTitle,
  pickVoiceActorName,
  stripHtml,
  truncate,
} from "@/lib/formatters";
import { getDict, getLang } from "@/lib/i18n";
import type { Dict, Lang } from "@/lib/i18n";
import type {
  AnimeDetail,
  DetailCharacter,
  DetailEpisodeTitle,
  DetailRecommendation,
  DetailRelation,
  DetailStaff,
} from "@/lib/types";

// ISR window — matches landing trending revalidate (60s) so cached
// upstream payloads cascade naturally.
export const revalidate = 60;

interface PageProps {
  params: Promise<{ id: string }>;
}

// --- Detail fetch helper (shared by generateMetadata + default export) ---

async function loadDetail(id: number): Promise<AnimeDetail | null> {
  try {
    return await apiGet<AnimeDetail>(`/api/anime/${id}`, { revalidate: 60 });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// --- Status / source / season labels ---

const SOURCE_LABEL: Record<string, { zh: string; en: string }> = {
  ORIGINAL: { zh: "原创", en: "Original" },
  MANGA: { zh: "漫改", en: "Manga" },
  LIGHT_NOVEL: { zh: "轻小说改", en: "Light Novel" },
  VISUAL_NOVEL: { zh: "视觉小说改", en: "Visual Novel" },
  VIDEO_GAME: { zh: "游戏改", en: "Video Game" },
  NOVEL: { zh: "小说改", en: "Novel" },
  WEB_NOVEL: { zh: "网文改", en: "Web Novel" },
  GAME: { zh: "游戏改", en: "Game" },
};

const RELATION_LABEL: Record<string, { zh: string; en: string }> = {
  PREQUEL: { zh: "前传", en: "Prequel" },
  SEQUEL: { zh: "续集", en: "Sequel" },
  SIDE_STORY: { zh: "番外", en: "Side Story" },
  PARENT: { zh: "本篇", en: "Parent" },
  CHARACTER: { zh: "角色出演", en: "Character" },
  SUMMARY: { zh: "总集篇", en: "Summary" },
  ALTERNATIVE: { zh: "替代版", en: "Alternative" },
  SPIN_OFF: { zh: "衍生作品", en: "Spin-Off" },
  ADAPTATION: { zh: "改编", en: "Adaptation" },
  OTHER: { zh: "其他", en: "Other" },
};

const RELATION_ORDER = [
  "PREQUEL",
  "SEQUEL",
  "PARENT",
  "SIDE_STORY",
  "SPIN_OFF",
  "ADAPTATION",
  "ALTERNATIVE",
  "SUMMARY",
  "CHARACTER",
  "OTHER",
];

const CHARACTER_ROLE_LABEL: Record<Lang, Record<string, string>> = {
  zh: { MAIN: "主角", SUPPORTING: "配角", BACKGROUND: "客串" },
  en: { MAIN: "Main", SUPPORTING: "Supporting", BACKGROUND: "Background" },
};

function scoreColor(s: number): string {
  if (s >= 75) return "#30d158";
  if (s >= 50) return "#ff9f0a";
  return "#ff453a";
}

function statusLabel(dict: Dict, status: string | null): string {
  if (!status) return "";
  const map: Record<string, string> = {
    RELEASING: dict.detail.releasing,
    FINISHED: dict.detail.finished,
    NOT_YET_RELEASED: dict.detail.notYetReleased,
    CANCELLED: dict.detail.cancelled,
  };
  return map[status] ?? status;
}

function seasonLabel(dict: Dict, season: string | null): string | null {
  if (!season) return null;
  const seasons = dict.season as unknown as Record<string, string>;
  return seasons[season] ?? season;
}

// --- generateMetadata: title / description / OG / Twitter / canonical ---

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const anilistId = Number(id);
  if (!Number.isFinite(anilistId) || anilistId <= 0) {
    return { title: "AnimeGo" };
  }

  const [lang, detail] = await Promise.all([getLang(), loadDetail(anilistId)]);
  if (!detail) {
    return { title: "AnimeGo" };
  }

  const title = pickTitle(detail, lang);
  const titleFull = `${title} · AnimeGo`;
  const description = truncate(stripHtml(detail.description || ""), 160);
  const locale = lang === "en" ? "en_US" : "zh_CN";
  const heroImage = detail.bannerImageUrl || detail.coverImageUrl || null;
  const canonical = `/anime/${anilistId}`;

  const openGraph: Metadata["openGraph"] = {
    title,
    description,
    siteName: "AnimeGo",
    locale,
    alternateLocale: lang === "en" ? ["zh_CN"] : ["en_US"],
    type: "video.tv_show",
    url: canonical,
  };
  const twitter: Metadata["twitter"] = {
    card: "summary_large_image",
    title,
    description,
  };
  if (heroImage) {
    openGraph.images = [heroImage];
    twitter.images = [heroImage];
  }

  return {
    title: { absolute: titleFull },
    description,
    openGraph,
    twitter,
    alternates: {
      canonical,
      languages: {
        "zh-CN": canonical,
        "en-US": `${canonical}?lang=en`,
      },
    },
  };
}

// --- JSON-LD TVSeries schema (Phase 5 acceptance) ---

interface JsonLdAggregateRating {
  "@type": "AggregateRating";
  ratingValue: number;
  bestRating: number;
  worstRating: number;
}

interface JsonLdTVSeries {
  "@context": "https://schema.org";
  "@type": "TVSeries";
  name: string;
  alternateName?: string[];
  image?: string;
  description?: string;
  numberOfEpisodes?: number;
  startDate?: string;
  genre?: string[];
  aggregateRating?: JsonLdAggregateRating;
  productionCompany?: { "@type": "Organization"; name: string }[];
}

function buildJsonLd(detail: AnimeDetail, lang: Lang): JsonLdTVSeries {
  const alts = [detail.titleRomaji, detail.titleEnglish, detail.titleNative].filter(
    (s): s is string => Boolean(s),
  );
  const ld: JsonLdTVSeries = {
    "@context": "https://schema.org",
    "@type": "TVSeries",
    name: pickTitle(detail, lang),
  };
  if (alts.length) ld.alternateName = alts;
  if (detail.coverImageUrl) ld.image = detail.coverImageUrl;
  const desc = stripHtml(detail.description || "");
  if (desc) ld.description = desc;
  if (detail.episodes) ld.numberOfEpisodes = detail.episodes;
  const formattedStartDate = formatFuzzyDate(detail.startDate);
  if (formattedStartDate) ld.startDate = formattedStartDate;
  if (detail.genres?.length) ld.genre = detail.genres;
  if (detail.averageScore && detail.averageScore > 0) {
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: detail.averageScore / 10,
      bestRating: 10,
      worstRating: 0,
    };
  }
  if (detail.studios?.length) {
    ld.productionCompany = detail.studios.map((name) => ({
      "@type": "Organization",
      name,
    }));
  }
  return ld;
}

// --- Style tokens (kept inline; matches legacy hero spec) ---

const S = {
  bannerOverlay: {
    position: "absolute" as const,
    inset: 0,
    background:
      "linear-gradient(to bottom, transparent 0%, transparent 40%, rgba(0,0,0,0.30) 65%, rgba(0,0,0,0.95) 100%)",
  },
  cover: {
    width: 210,
    height: 300,
    objectFit: "cover" as const,
    borderRadius: 12,
    border: "1px solid rgba(84,84,88,0.65)",
    background: "#1c1c1e",
    display: "block",
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontSize: "clamp(22px, 4vw, 36px)",
    color: "#ffffff",
    marginBottom: 4,
    lineHeight: 1.2,
  },
  subtitle: {
    color: "rgba(235,235,245,0.60)",
    fontSize: 15,
    marginBottom: 16,
  },
  badgeRow: { display: "flex" as const, flexWrap: "wrap" as const, gap: 10, marginBottom: 16 },
  badge: (bg: string, color: string): CSSProperties => ({
    padding: "4px 12px",
    borderRadius: 9999,
    background: bg,
    color,
    fontSize: 13,
  }),
  scoreBadge: (color: string): CSSProperties => ({
    padding: "4px 12px",
    borderRadius: 9999,
    background: "rgba(255,159,10,0.12)",
    color,
    fontWeight: 700,
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
  }),
  bgmScoreBadge: {
    padding: "4px 12px",
    borderRadius: 9999,
    background: "rgba(255,69,58,0.10)",
    color: "#ff453a",
    fontWeight: 700 as const,
    fontSize: 13,
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: 5,
    fontFamily: "'JetBrains Mono', monospace",
  },
  bgmLabel: { fontSize: 10, opacity: 0.7, fontFamily: "'DM Sans', sans-serif" },
  bgmVotes: { fontSize: 11, opacity: 0.6, fontWeight: 400 },
  bgmLink: {
    padding: "4px 12px",
    borderRadius: 9999,
    background: "rgba(255,69,58,0.10)",
    color: "#ff453a",
    fontSize: 13,
    textDecoration: "none",
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: 4,
    fontWeight: 500 as const,
  },
  metaRow: {
    display: "flex" as const,
    flexWrap: "wrap" as const,
    gap: "4px 12px",
    marginBottom: 16,
    alignItems: "center" as const,
  },
  metaStudio: { color: "rgba(235,235,245,0.75)", fontSize: 13 },
  metaDot: { color: "rgba(84,84,88,0.65)", fontSize: 13 },
  metaDetail: { color: "rgba(235,235,245,0.50)", fontSize: 12 },
  genreRow: { display: "flex" as const, flexWrap: "wrap" as const, gap: 6, marginBottom: 20 },
  genreTag: {
    padding: "4px 10px",
    borderRadius: 9999,
    background: "rgba(120,120,128,0.12)",
    color: "rgba(235,235,245,0.60)",
    fontSize: 12,
    fontWeight: 500 as const,
  },
  descText: {
    color: "rgba(235,235,245,0.75)",
    fontSize: 14,
    lineHeight: 1.8,
    whiteSpace: "pre-wrap" as const,
  },
  sectionLabel: {
    color: "#0a84ff",
    fontSize: 13,
    fontWeight: 600 as const,
    letterSpacing: "2px",
    textTransform: "uppercase" as const,
    marginBottom: 16,
  },
} satisfies Record<string, CSSProperties | ((...args: never[]) => CSSProperties)>;

// --- Hero (banner + cover + meta block) ---

// Relation types we surface inline in the hero (matches the legacy
// SHOWN_RELATIONS set). RecommendationsSection further down still
// renders the full relation set; this inline strip is a UX shortcut so
// users see the prequel/sequel without scrolling.
const HERO_SHOWN_RELATIONS = new Set([
  "PREQUEL",
  "SEQUEL",
  "PARENT",
  "SIDE_STORY",
  "SPIN_OFF",
]);

const DESC_TRUNCATE_THRESHOLD = 300;

function Hero({ detail, lang, dict }: { detail: AnimeDetail; lang: Lang; dict: Dict }) {
  const title = pickTitle(detail, lang);
  // Full description for SEO; truncated mirror for the collapsed UI
  // state. The client-side toggle in DescriptionExpand swaps between
  // them so the rendered HTML always contains both (crawlers see the
  // full text inside the rendered <p>).
  const descFull = stripHtml(detail.description || "");
  const descTruncated = truncate(descFull, DESC_TRUNCATE_THRESHOLD);
  const descNeedsToggle = descFull.length > DESC_TRUNCATE_THRESHOLD;
  const heroRelations = (detail.relations ?? []).filter((r) =>
    HERO_SHOWN_RELATIONS.has(r.relationType),
  );
  const sourceLabel = detail.source ? SOURCE_LABEL[detail.source]?.[lang] ?? null : null;
  const durationLabel = detail.duration
    ? lang === "zh"
      ? `${detail.duration}分/集`
      : `${detail.duration} min/ep`
    : null;
  const seasonLab = seasonLabel(dict, detail.season);
  const score = detail.averageScore;
  const accent = detail.posterAccent || null;
  const startDateLabel = formatFuzzyDate(detail.startDate, lang);

  return (
    <div>
      {/* Banner */}
      <div
        style={{
          position: "relative",
          height: detail.bannerImageUrl ? 400 : 120,
          background: detail.bannerImageUrl
            ? `url(${detail.bannerImageUrl}) center/cover`
            : "#000000",
          overflow: "hidden",
        }}
      >
        <div style={S.bannerOverlay} />
      </div>

      {/* Content */}
      <div
        className="container"
        style={{
          display: "flex",
          gap: 32,
          marginTop: detail.bannerImageUrl ? -80 : 24,
          position: "relative",
          zIndex: 1,
          paddingBottom: 40,
          flexWrap: "wrap",
        }}
      >
        {/* Cover */}
        <div style={{ flexShrink: 0 }}>
          {detail.coverImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={detail.coverImageUrl}
              alt={title}
              width={210}
              height={300}
              fetchPriority="high"
              decoding="async"
              style={{
                ...S.cover,
                ...(accent ? { boxShadow: `0 12px 36px ${accent}55` } : {}),
              }}
            />
          ) : (
            <div style={{ ...S.cover, background: "#2c2c2e" }} aria-hidden />
          )}
        </div>

        {/* Meta */}
        <div style={{ flex: 1, minWidth: 280, paddingTop: detail.bannerImageUrl ? 60 : 0 }}>
          <h1 style={S.title}>{title}</h1>
          {lang === "zh" && detail.titleNative && (
            <p style={S.subtitle}>{detail.titleNative}</p>
          )}
          {lang === "zh" && !detail.titleNative && detail.titleRomaji && (
            <p style={S.subtitle}>{detail.titleRomaji}</p>
          )}

          {/* Badges */}
          <div style={S.badgeRow}>
            {score && score > 0 ? (
              <span style={S.scoreBadge(scoreColor(score))}>
                {"★"} {formatScore(score)}
              </span>
            ) : null}
            {detail.bangumiScore && detail.bangumiScore > 0 ? (
              <span style={S.bgmScoreBadge}>
                <span style={S.bgmLabel}>BGM</span>
                {"★"} {detail.bangumiScore.toFixed(1)}
                {detail.bangumiVotes && detail.bangumiVotes > 0 ? (
                  <span style={S.bgmVotes}>({detail.bangumiVotes.toLocaleString()})</span>
                ) : null}
              </span>
            ) : null}
            {detail.format && (
              <span style={S.badge("rgba(10,132,255,0.12)", "#0a84ff")}>{detail.format}</span>
            )}
            {detail.status && (
              <span style={S.badge("rgba(90,200,250,0.10)", "#5ac8fa")}>
                {statusLabel(dict, detail.status)}
              </span>
            )}
            {detail.episodes ? (
              <span style={S.badge("rgba(120,120,128,0.12)", "rgba(235,235,245,0.60)")}>
                {detail.episodes} {dict.detail.epUnit}
              </span>
            ) : null}
            {seasonLab && detail.seasonYear ? (
              <span style={S.badge("rgba(120,120,128,0.12)", "rgba(235,235,245,0.60)")}>
                {seasonLab} {detail.seasonYear}
              </span>
            ) : null}
            {detail.bgmId ? (
              <a
                href={`https://bgm.tv/subject/${detail.bgmId}`}
                target="_blank"
                rel="noopener noreferrer"
                style={S.bgmLink}
              >
                <span style={{ fontSize: 10, opacity: 0.8 }}>{"▶"}</span>
                {dict.detail.viewOnBgm}
              </a>
            ) : null}
          </div>

          {/* Meta row */}
          {(detail.studios.length > 0 || sourceLabel || durationLabel || startDateLabel) && (
            <div style={S.metaRow}>
              {detail.studios.length > 0 && (
                <span style={S.metaStudio}>{detail.studios.join(" · ")}</span>
              )}
              {detail.studios.length > 0 &&
                (sourceLabel || durationLabel || startDateLabel) && (
                  <span style={S.metaDot}>{"·"}</span>
                )}
              {sourceLabel && <span style={S.metaDetail}>{sourceLabel}</span>}
              {durationLabel && <span style={S.metaDetail}>{durationLabel}</span>}
              {startDateLabel && <span style={S.metaDetail}>{startDateLabel}</span>}
            </div>
          )}

          {/* Genres */}
          {detail.genres.length > 0 && (
            <div style={S.genreRow}>
              {detail.genres.map((g) => (
                <span key={g} style={S.genreTag}>
                  {g}
                </span>
              ))}
            </div>
          )}

          {/* Description with 展开更多 / 收起 toggle */}
          {descFull && (
            <div style={{ marginBottom: heroRelations.length > 0 ? 20 : 0 }}>
              <DescriptionExpand
                truncated={descTruncated}
                full={descFull}
                needsToggle={descNeedsToggle}
                expandLabel={dict.detail.readMore}
                collapseLabel={dict.detail.collapse}
              />
            </div>
          )}

          {/* Inline relations (prequel / sequel / parent / side story /
              spin-off) — matches legacy AnimeDetailHero.jsx behavior of
              keeping the most important relations close to the title
              instead of forcing the user to scroll to the relations
              section. The full RelationsSection still renders below. */}
          {heroRelations.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginTop: 12,
              }}
            >
              {heroRelations.map((r) => {
                const relLabel =
                  RELATION_LABEL[r.relationType]?.[lang] ?? r.relationType;
                const relTitle =
                  (lang === "zh" ? r.titleChinese : null) ||
                  r.titleRomaji ||
                  r.titleChinese ||
                  `Anime #${r.anilistId}`;
                return (
                  <Link
                    key={`${r.relationType}-${r.anilistId}`}
                    href={`/anime/${r.anilistId}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 12px",
                      borderRadius: 8,
                      background: "rgba(120,120,128,0.12)",
                      border: "1px solid rgba(84,84,88,0.65)",
                      color: "rgba(235,235,245,0.60)",
                      fontSize: 12,
                      fontWeight: 500,
                      textDecoration: "none",
                    }}
                  >
                    <span
                      style={{
                        color: "rgba(235,235,245,0.35)",
                        fontSize: 11,
                      }}
                    >
                      {relLabel}
                    </span>
                    {relTitle}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Relations section ---

function RelationsSection({
  relations,
  lang,
}: {
  relations: DetailRelation[];
  lang: Lang;
}) {
  if (!relations.length) return null;
  const sorted = [...relations].sort((a, b) => {
    const ai = RELATION_ORDER.indexOf(a.relationType);
    const bi = RELATION_ORDER.indexOf(b.relationType);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <section style={{ margin: "32px 0" }}>
      <h2
        style={{
          fontFamily: "'Sora',sans-serif",
          fontSize: 16,
          fontWeight: 700,
          color: "#ffffff",
          marginBottom: 16,
        }}
      >
        {lang === "zh" ? "关联作品" : "Relations"}
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 12,
        }}
      >
        {sorted.map((rel) => {
          const label =
            RELATION_LABEL[rel.relationType]?.[lang] ?? rel.relationType;
          const relTitle =
            (lang === "zh" && rel.titleChinese) || rel.titleRomaji || "";
          return (
            <Link
              key={`${rel.anilistId}-${rel.relationType}`}
              href={`/anime/${rel.anilistId}`}
              prefetch={false}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: "#1c1c1e",
                border: "1px solid #38383a",
                borderRadius: 10,
                padding: 10,
                textDecoration: "none",
                color: "inherit",
              }}
            >
              {rel.coverImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={rel.coverImageUrl}
                  alt={relTitle}
                  loading="lazy"
                  decoding="async"
                  width={48}
                  height={64}
                  style={{
                    width: 48,
                    height: 64,
                    objectFit: "cover",
                    borderRadius: 6,
                    flexShrink: 0,
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 48,
                    height: 64,
                    borderRadius: 6,
                    flexShrink: 0,
                    background: "#2c2c2e",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    color: "rgba(235,235,245,0.30)",
                  }}
                >
                  N/A
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: "inline-block",
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#0a84ff",
                    textTransform: "uppercase",
                    marginBottom: 4,
                  }}
                >
                  {label}
                </span>
                <p
                  style={{
                    fontFamily: "'Sora',sans-serif",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#ffffff",
                    margin: 0,
                    lineHeight: 1.35,
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {relTitle}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// --- Characters section ---

function CharactersSection({
  characters,
  lang,
}: {
  characters: DetailCharacter[];
  lang: Lang;
}) {
  if (!characters.length) return null;
  const label = lang === "zh" ? "角色 & 配音" : "Characters";
  const jaLabel = lang === "zh" ? "日语" : "Japanese";

  return (
    <section style={{ marginTop: 40 }}>
      <h2 style={S.sectionLabel as CSSProperties}>{label}</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
          gap: 8,
        }}
      >
        {characters.map((c, i) => {
          const roleKey = c.role?.toUpperCase() || "SUPPORTING";
          const roleLabel =
            CHARACTER_ROLE_LABEL[lang]?.[roleKey] ?? roleKey;
          // Field shape on the wire is {nameEn|nameJa|nameCn, voiceActor*}.
          // pickCharacterName picks lang-appropriate with fallback so a
          // missing nameCn surfaces nameJa instead of "—".
          const charName = pickCharacterName(c, lang) || "—";
          const va = pickVoiceActorName(c, lang) || null;
          return (
            <div
              key={`${charName}-${i}`}
              style={{
                display: "flex",
                alignItems: "stretch",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(84,84,88,0.30)",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    width: 58,
                    height: 76,
                    flexShrink: 0,
                    borderRadius: 4,
                    overflow: "hidden",
                    background: "#2c2c2e",
                    border: "1px solid #38383a",
                  }}
                >
                  {c.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.imageUrl}
                      alt={charName}
                      loading="lazy"
                      decoding="async"
                      width={58}
                      height={76}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : null}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#ffffff",
                      lineHeight: 1.35,
                      wordBreak: "break-word",
                    }}
                  >
                    {charName}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "rgba(235,235,245,0.40)",
                      marginTop: 3,
                    }}
                  >
                    {roleLabel}
                  </div>
                </div>
              </div>
              {va && (
                <>
                  <div
                    style={{
                      width: 1,
                      background: "rgba(84,84,88,0.30)",
                      flexShrink: 0,
                    }}
                  />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        width: 58,
                        height: 76,
                        flexShrink: 0,
                        borderRadius: 4,
                        overflow: "hidden",
                        background: "#2c2c2e",
                        border: "1px solid #38383a",
                      }}
                    >
                      {c.voiceActorImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={c.voiceActorImageUrl}
                          alt={va}
                          loading="lazy"
                          decoding="async"
                          width={58}
                          height={76}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : null}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "#ffffff",
                          lineHeight: 1.35,
                          wordBreak: "break-word",
                        }}
                      >
                        {va}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "rgba(235,235,245,0.40)",
                          marginTop: 3,
                        }}
                      >
                        {jaLabel}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Staff section ---

function StaffSectionView({ staff, lang }: { staff: DetailStaff[]; lang: Lang }) {
  if (!staff.length) return null;
  const label = lang === "zh" ? "制作人员" : "Staff";

  return (
    <section style={{ marginTop: 40 }}>
      <h2 style={S.sectionLabel as CSSProperties}>{label}</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "10px 16px",
        }}
      >
        {staff.map((s, i) => {
          // Wire shape is {nameEn, nameJa, role, imageUrl} — no top-level
          // `name`. pickStaffName: zh prefers Japanese (legacy convention),
          // en prefers English. Falls back across both before "—".
          const staffName = pickStaffName(s, lang) || "—";
          return (
          <div
            key={`${staffName}-${i}`}
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                flexShrink: 0,
                overflow: "hidden",
                background: "#2c2c2e",
                border: "1px solid #38383a",
              }}
            >
              {s.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={s.imageUrl}
                  alt={staffName}
                  loading="lazy"
                  decoding="async"
                  width={36}
                  height={36}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : null}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#ffffff",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {staffName}
              </div>
              {s.role && (
                <div
                  style={{
                    fontSize: 11,
                    color: "rgba(235,235,245,0.40)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.role}
                </div>
              )}
            </div>
          </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Recommendations section (uses AnimeCard for visual parity) ---

function RecommendationsSection({
  recommendations,
  lang,
}: {
  recommendations: DetailRecommendation[];
  lang: Lang;
}) {
  if (!recommendations.length) return null;
  const label = lang === "zh" ? "看了这部还在看" : "You Might Also Like";
  const items = recommendations.slice(0, 8);

  return (
    <section style={{ marginTop: 40, marginBottom: 60 }}>
      <h2 style={S.sectionLabel as CSSProperties}>{label}</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
          gap: 12,
        }}
      >
        {items.map((r) => (
          <AnimeCard
            key={r.anilistId}
            anime={{
              anilistId: r.anilistId,
              titleRomaji: r.titleRomaji,
              titleChinese: r.titleChinese,
              coverImageUrl: r.coverImageUrl,
              averageScore: r.averageScore,
            }}
            lang={lang}
            prefetch={false}
          />
        ))}
      </div>
    </section>
  );
}

// --- Episodes section ---
//
// Static SEO surface: a grid of numbered cells, one per episode index from
// 1 to `episodes`. Each cell shows the episode number plus a title when
// the matching `episodeTitles` entry has one. No clickability — player
// integration lives behind auth on a client route (Phase 6+).
//
// Many shows have `episodes > 0` but an empty `episodeTitles` array
// (Bangumi enrichment ran and found nothing). We still render numbered
// cells in that case; just the number alone is fine — no placeholder dash.

function EpisodesSection({
  episodes,
  episodeTitles,
  lang,
  dict,
}: {
  episodes: number | null;
  episodeTitles: DetailEpisodeTitle[];
  lang: Lang;
  dict: Dict;
}) {
  if (!episodes || episodes <= 0) return null;

  // Index titles by episode number for O(1) lookup. The wire array is
  // typically small (<= 100) and sparse, so a Map is overkill but cheap.
  const titleByEpisode = new Map<number, DetailEpisodeTitle>();
  for (const t of episodeTitles) {
    if (typeof t.episode === "number") titleByEpisode.set(t.episode, t);
  }

  const cells: { n: number; title: string }[] = [];
  for (let n = 1; n <= episodes; n += 1) {
    const t = titleByEpisode.get(n);
    const title = t ? (lang === "zh" ? t.nameCn || t.name || "" : t.name || t.nameCn || "") : "";
    cells.push({ n, title });
  }

  return (
    <section style={{ marginTop: 40, marginBottom: 60 }}>
      <h2 style={S.sectionLabel as CSSProperties}>{dict.detail.episodes}</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: 8,
        }}
      >
        {cells.map((cell) => (
          <div
            key={cell.n}
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(84,84,88,0.30)",
              borderRadius: 6,
              padding: "10px 12px",
              minWidth: 0,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "rgba(235,235,245,0.60)",
                marginBottom: cell.title ? 4 : 0,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {lang === "zh" ? `第${cell.n}集` : `Ep ${cell.n}`}
            </div>
            {cell.title && (
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: "#ffffff",
                  lineHeight: 1.35,
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  wordBreak: "break-word",
                }}
              >
                {cell.title}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// --- Page entry ---

export default async function AnimeDetailPage({ params }: PageProps) {
  const { id } = await params;
  const anilistId = Number(id);
  if (!Number.isFinite(anilistId) || anilistId <= 0) notFound();

  const [dict, lang, detail] = await Promise.all([
    getDict(),
    getLang(),
    loadDetail(anilistId),
  ]);
  if (!detail) notFound();

  const jsonLd = buildJsonLd(detail, lang);

  return (
    <>
      {/* JSON-LD TVSeries: Google Rich Results gate for Phase 5 acceptance.
          dangerouslySetInnerHTML is safe here: jsonLd is built from typed
          AnimeDetail server fields, never from raw user input. We still
          guard against </script> sequences as defense in depth. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />
      <main>
        <Hero detail={detail} lang={lang} dict={dict} />
        <div className="container">
          <DetailActions
            anilistId={detail.anilistId}
            episodes={detail.episodes}
            titleRomaji={detail.titleRomaji}
            titleEnglish={detail.titleEnglish}
            titleChinese={detail.titleChinese}
            titleNative={detail.titleNative}
            coverImageUrl={detail.coverImageUrl}
            shareTitle={pickTitle(detail, lang)}
            labels={{
              subAdd: dict.sub.addToList,
              subWatching: dict.sub.watching,
              subRemove: dict.sub.remove,
              subLogin: dict.sub.loginToWatch,
              subLoginAria: dict.sub.loginToWatch,
              share: dict.social.share,
              shareCopied: dict.detail.linkCopied,
              shareCopyFailed: dict.detail.linkCopyFailed,
              torrents: dict.torrent.download,
              torrentsTitle: dict.torrent.title,
              torrentsEmpty: dict.torrent.empty,
              torrentsSearchExternally: dict.torrent.searchExternally,
              torrentsClose: dict.torrent.close,
              play: dict.detail.openPlayer,
              playAria: dict.detail.openPlayerAria,
            }}
          />
          <WatchersAvatarList anilistId={detail.anilistId} />
          <RelationsSection relations={detail.relations} lang={lang} />
          <CharactersSection characters={detail.characters} lang={lang} />
          <StaffSectionView staff={detail.staff} lang={lang} />
          <EpisodesSection
            episodes={detail.episodes}
            episodeTitles={detail.episodeTitles ?? []}
            lang={lang}
            dict={dict}
          />
          <RecommendationsSection
            recommendations={detail.recommendations}
            lang={lang}
          />
        </div>
      </main>
    </>
  );
}
