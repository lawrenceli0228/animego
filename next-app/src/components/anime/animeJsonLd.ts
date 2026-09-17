// The schema.org TVSeries document injected into /anime/[id].
//
// Pure logic, no React and no DOM, split out of page.tsx for the reason
// testImportHygiene.test.ts states as the repo convention: a test cannot
// import the page. `page.tsx -> DetailActions.tsx -> SubscriptionButton.tsx
// -> react-hot-toast`, and react-hot-toast touches `document` while its module
// is still evaluating, so any suite reaching it dies before its first
// assertion. Same split as episodeGridSkeleton.ts and continueWatchingState.ts
// next door.
//
// It is worth a module of its own rather than a grep-able line in the page,
// because the one rule it carries (see numberOfEpisodes below) is the kind
// that only stays true if something executes it.

import { visibleSynonyms } from "@/components/anime/detailFacts";
import { DETAIL_CHARACTERS_SHOWN, DETAIL_STAFF_SHOWN } from "@/components/anime/detailPeople";
import { genreFromSlug, genrePath, genreSlug, yearPath } from "@/lib/hubs/paths";
import { genreHeading, yearHeading } from "@/lib/hubs/headings";
import { normalizeStaffRole, seasonYearLabel } from "@/lib/contentLabels";
import {
  formatFuzzyDate,
  pickCharacterName,
  pickSeoTitle,
  pickStaffName,
  pickTitle,
  pickVoiceActorName,
  stripHtml,
} from "@/lib/formatters";
import type { Lang } from "@/lib/i18n/lang";
import { localeForLang } from "@/lib/i18n/locale";
import { absoluteUrl } from "@/lib/seo/alternates";
import type { AnimeDetail, DetailCharacter, DetailStaff } from "@/lib/types";

export interface JsonLdAggregateRating {
  "@type": "AggregateRating";
  ratingValue: number;
  // Google rejects AggregateRating without a count (ratingCount/reviewCount).
  // Only Bangumi gives us a real vote count, so the rating is sourced from
  // Bangumi (score + votes), matching the visible "★ x.x (n)" badge on-page.
  ratingCount: number;
  bestRating: number;
  worstRating: number;
}

export interface JsonLdPerson {
  "@type": "Person";
  name: string;
  /** The AniList page for the person or character, when the row has its id. */
  sameAs?: string;
}

export interface JsonLdOrganization {
  "@type": "Organization";
  name: string;
  sameAs?: string;
}

export interface JsonLdTVSeries {
  "@context": "https://schema.org";
  "@type": "TVSeries";
  name: string;
  alternateName?: string[];
  image?: string;
  description?: string;
  numberOfEpisodes?: number;
  startDate?: string;
  endDate?: string;
  genre?: string[];
  aggregateRating?: JsonLdAggregateRating;
  productionCompany?: JsonLdOrganization[];
  actor?: JsonLdPerson[];
  character?: JsonLdPerson[];
  director?: JsonLdPerson[];
  musicBy?: JsonLdPerson[];
  sameAs?: string[];
}

export interface JsonLdBreadcrumbList {
  "@context": "https://schema.org";
  "@type": "BreadcrumbList";
  itemListElement: JsonLdListItem[];
}

export interface JsonLdListItem {
  "@type": "ListItem";
  position: number;
  name: string;
  /** Absent on the last crumb: it is the page itself. */
  item?: string;
}

/**
 * The URLs that identify this work elsewhere, for schema.org `sameAs`.
 *
 * The AniList page always exists (the id is the row's key); the Bangumi
 * and MyAnimeList pages when the ids are known; then the official site and
 * the social accounts AniList lists. Streaming pages are not identity — a
 * Crunchyroll listing says where to watch, not what the work is — so they
 * stay out. Exported for the test; the order is stable so a diff on the
 * emitted document is readable.
 */
export function sameAsUrls(detail: AnimeDetail): string[] {
  const urls = [`https://anilist.co/anime/${detail.anilistId}`];
  if (detail.bgmId) urls.push(`https://bgm.tv/subject/${detail.bgmId}`);
  if (detail.malId) urls.push(`https://myanimelist.net/anime/${detail.malId}`);
  for (const link of detail.externalLinks ?? []) {
    const official = link.site === "Official Site";
    const social = link.type === "SOCIAL";
    if ((official || social) && /^https?:\/\//.test(link.url) && !urls.includes(link.url)) {
      urls.push(link.url);
    }
  }
  return urls;
}

const ANILIST = "https://anilist.co";

/** Staff roles that are the work's director, after normalizeStaffRole. */
const DIRECTOR_ROLES: ReadonlySet<string> = new Set(["Director", "Chief Director"]);
const MUSIC_ROLES: ReadonlySet<string> = new Set(["Music"]);

function person(name: string, sameAs: string | null): JsonLdPerson {
  return sameAs ? { "@type": "Person", name, sameAs } : { "@type": "Person", name };
}

/**
 * One Person per distinct name, in first-seen order. Keyed by name rather
 * than id because a row written before migration 0037 carries no ids at
 * all, and the same actor voicing two roles is the case this exists for.
 */
function dedupePeople(people: JsonLdPerson[]): JsonLdPerson[] {
  const seen = new Set<string>();
  return people.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}

/**
 * The voice cast, from the characters the page draws. `actor` is the
 * person; `character` is who they play. The two lists are emitted side by
 * side rather than as PerformanceRole pairs because Google reads `actor`
 * as a list of Person and a nested Role object is the shape it does not
 * document — and the visible page presents them the same way, as two
 * columns of one row.
 */
export function castJsonLd(
  characters: DetailCharacter[],
  lang: Lang,
): { actor: JsonLdPerson[]; character: JsonLdPerson[] } {
  const shown = characters.slice(0, DETAIL_CHARACTERS_SHOWN);
  const actor: JsonLdPerson[] = [];
  const character: JsonLdPerson[] = [];
  for (const c of shown) {
    const charName = pickCharacterName(c, lang);
    if (charName) {
      character.push(person(charName, c.characterId ? `${ANILIST}/character/${c.characterId}` : null));
    }
    const vaName = pickVoiceActorName(c, lang);
    if (vaName) {
      actor.push(person(vaName, c.voiceActorId ? `${ANILIST}/staff/${c.voiceActorId}` : null));
    }
  }
  return { actor: dedupePeople(actor), character: dedupePeople(character) };
}

/** The staff on the page whose normalized role is in `roles`. */
export function staffByRole(
  staff: DetailStaff[],
  roles: ReadonlySet<string>,
  lang: Lang,
): JsonLdPerson[] {
  const people: JsonLdPerson[] = [];
  for (const s of staff.slice(0, DETAIL_STAFF_SHOWN)) {
    if (!s.role || !roles.has(normalizeStaffRole(s.role))) continue;
    const name = pickStaffName(s, lang);
    if (name) people.push(person(name, s.staffId ? `${ANILIST}/staff/${s.staffId}` : null));
  }
  return dedupePeople(people);
}

export function buildJsonLd(detail: AnimeDetail, lang: Lang): JsonLdTVSeries {
  // The three other titles the hero prints, then the synonyms the info
  // table prints (visibleSynonyms already drops the four titles and
  // duplicates). AniList's synonyms are where the Chinese and the fan
  // spellings live, which is what a searcher types.
  const alts = [
    ...[detail.titleRomaji, detail.titleEnglish, detail.titleNative].filter(
      (s): s is string => Boolean(s),
    ),
    ...visibleSynonyms(detail, lang),
  ];
  const ld: JsonLdTVSeries = {
    "@context": "https://schema.org",
    "@type": "TVSeries",
    // JSON-LD `name` is the most explicit "this page is about a thing called
    // X" signal on the page, so it takes the SERP-safe field for the same
    // reason <title> does.
    name: pickSeoTitle(detail, lang),
  };
  if (alts.length) ld.alternateName = alts;
  if (detail.coverImageUrl) ld.image = detail.coverImageUrl;
  const desc = stripHtml(detail.description || "");
  if (desc) ld.description = desc;
  // R3, and the reason AnimeDetail carries two episode counts instead of one.
  //
  // `detail.episodes` is AniList's authoritative total. `detail.episodesBgm`
  // is a sweep's inference from an external episode source, and it is
  // populated for exactly the rows this one is NULL for — so a fallback here
  // would fire precisely when it must not.
  //
  // numberOfEpisodes is not a number on a page. It is a machine-readable
  // claim about the work, addressed to a search engine that will treat it as
  // fact and may surface it away from any page that could qualify it. The
  // badge and the episode grid on this same route DO fall back to the
  // inferred count; this line is where that permission stops.
  //
  // Omitting the property entirely is the correct answer when the
  // authoritative count is unknown. An absent numberOfEpisodes says nothing;
  // a guessed one says something false.
  if (detail.episodes) ld.numberOfEpisodes = detail.episodes;
  const formattedStartDate = formatFuzzyDate(detail.startDate);
  if (formattedStartDate) ld.startDate = formattedStartDate;
  // Same treatment as startDate. The writer only stores a whole date, so
  // there is no partial-date case to refuse here; an absent value is a work
  // still airing (or one AniList has no end date for) and says nothing.
  const formattedEndDate = formatFuzzyDate(detail.endDate);
  if (formattedEndDate) ld.endDate = formattedEndDate;
  if (detail.genres?.length) ld.genre = detail.genres;
  // Bangumi rating carries a real vote count (Subject.Rating.Count), which
  // Google requires for a valid AggregateRating. AniList's averageScore has
  // no count, so an AniList-sourced rating is always rejected — omit it.
  if (
    detail.bangumiScore &&
    detail.bangumiScore > 0 &&
    detail.bangumiVotes &&
    detail.bangumiVotes > 0
  ) {
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: detail.bangumiScore,
      ratingCount: detail.bangumiVotes,
      bestRating: 10,
      worstRating: 1,
    };
  }
  if (detail.studios?.length) {
    // `studios` is the main studios by name; `studioDetails` (migration
    // 0038) carries the AniList id behind each, when the row has been
    // re-read since. The id is the disambiguation: there are two
    // "Production I.G"s on AniList and one of them is a typo.
    const idByName = new Map(
      (detail.studioDetails ?? []).flatMap((s) => (s.studioId ? [[s.name, s.studioId] as const] : [])),
    );
    ld.productionCompany = detail.studios.map((name) => {
      const id = idByName.get(name);
      return id
        ? { "@type": "Organization", name, sameAs: `${ANILIST}/studio/${id}` }
        : { "@type": "Organization", name };
    });
  }
  // The people, limited to what the page draws (see detailPeople.ts).
  // Each property is omitted rather than emitted empty: an empty `director`
  // reads as "this work has no director", which is never what we know.
  const cast = castJsonLd(detail.characters ?? [], lang);
  if (cast.actor.length) ld.actor = cast.actor;
  if (cast.character.length) ld.character = cast.character;
  const director = staffByRole(detail.staff ?? [], DIRECTOR_ROLES, lang);
  if (director.length) ld.director = director;
  const musicBy = staffByRole(detail.staff ?? [], MUSIC_ROLES, lang);
  if (musicBy.length) ld.musicBy = musicBy;
  // sameAs is the disambiguation signal: this page is about the work that
  // AniList, Bangumi and MyAnimeList each have a page for, not about a site
  // that happens to share a name (see the AnimeGO.org confusion).
  ld.sameAs = sameAsUrls(detail);
  return ld;
}

// ---------------------------------------------------------------------------
// BreadcrumbList
// ---------------------------------------------------------------------------

/**
 * The one hub this title hangs under, for the breadcrumb's middle crumb.
 *
 * Season first, because /seasonal is the hierarchy the site's own nav
 * presents (首页 › 季度) and the page that has listed the title since
 * before the hubs existed. A title with a year but no season (most films,
 * anything AniList has only a start date for) hangs under /year; one with
 * neither hangs under its first genre that has a page. A title with none
 * of those gets no middle crumb.
 */
export function breadcrumbParent(
  detail: AnimeDetail,
  lang: Lang,
): { name: string; path: string } | null {
  if (detail.season && detail.seasonYear) {
    return {
      name: seasonYearLabel(detail.season, detail.seasonYear, lang),
      path: `/seasonal/${detail.season.toLowerCase()}/${detail.seasonYear}`,
    };
  }
  const year = detail.seasonYear ?? releaseYear(detail.startDate);
  if (year) return { name: yearHeading(year, lang), path: yearPath(year) };
  for (const genre of detail.genres ?? []) {
    if (genreFromSlug(genreSlug(genre))) {
      return { name: genreHeading(genre, lang), path: genrePath(genre) };
    }
  }
  return null;
}

function releaseYear(startDate: AnimeDetail["startDate"]): number | null {
  if (!startDate) return null;
  const year = typeof startDate === "string" ? Number(startDate.slice(0, 4)) : startDate.year;
  return year && year > 0 ? year : null;
}

/**
 * The schema.org BreadcrumbList for /anime/[id]: home › hub › this title.
 *
 * Crumb URLs are absolute and locale-prefixed, so /en/anime/1 points at
 * /en/seasonal/... — a breadcrumb that crossed locales would tell Google
 * the English page's parent is a Chinese one. The last crumb carries no
 * `item`: it is the page the document is on, and its canonical already
 * says where that is.
 */
export function buildBreadcrumbJsonLd(
  detail: AnimeDetail,
  lang: Lang,
  homeLabel: string,
): JsonLdBreadcrumbList {
  const locale = localeForLang(lang);
  const crumbs: JsonLdListItem[] = [
    { "@type": "ListItem", position: 1, name: homeLabel, item: absoluteUrl("/", locale) },
  ];
  const parent = breadcrumbParent(detail, lang);
  if (parent) {
    crumbs.push({
      "@type": "ListItem",
      position: 2,
      name: parent.name,
      item: absoluteUrl(parent.path, locale),
    });
  }
  crumbs.push({ "@type": "ListItem", position: crumbs.length + 1, name: pickTitle(detail, lang) });
  return { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbs };
}
