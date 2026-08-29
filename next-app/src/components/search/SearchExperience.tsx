"use client";

// /search, from the first keystroke onward.
//
// This used to be a debounced `router.push` back into the Server Component:
// every settled keystroke was a full RSC round trip that re-rendered the whole
// page. Measured against production by typing 进击的巨人 one character at a
// time, that cost four server round trips for one five-character title, and
// three things went wrong along the way.
//
//   1. Nothing on screen acknowledged the keystroke. `router.push` runs inside
//      a React transition, so the old results stayed put with no pending state
//      of any kind until the new payload landed — a dead zone the reader reads
//      as a hang, not as work in progress.
//
//   2. The page re-seeded the input from the server's `q` on every response
//      (`useEffect(() => setQ(initialQ), [initialQ])`). Type faster than the
//      round trip and the reply for the *previous* keystroke rewound the box:
//      the probe typed 进击的巨人 and the URL ended up at 进击的人. The 巨 was
//      not dropped by the network — the page overwrote it.
//
//   3. An IME was not accounted for anywhere. Chrome fires `input` (and so
//      React's onChange) for every letter of a composition, so a reader typing
//      pinyin fired searches for `j`, `jin`, `jinj`, `jinji` — strings that by
//      construction match nothing in the catalogue, which means every one of
//      them fell through the local query and out to AniList.
//
// So the query now lives here. Typing hits GET /api/anime/search directly,
// results swap in place, the URL is kept shareable with history.replaceState
// (no navigation), and a superseded request is aborted rather than raced.
// The Server Component still renders the first result set, so a shared link
// and a crawler get exactly what they did before.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CompositionEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import AnimeCard, { type AnimeCardData } from "@/components/anime/AnimeCard";
import { SubscriptionSetProvider } from "@/components/anime/SubscriptionSetProvider";
import Link, { localizeHref, useLocale } from "@/components/ui/LocaleLink";
import { FILTER_GENRES, genreLabel } from "@/lib/contentLabels";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import { useLang } from "@/lib/lang-client";
import { buildHeading } from "./searchHeading";
import {
  errorFromResponse,
  hasTerms,
  makeQuery,
  parseSearchResponse,
  queryKey,
  sameTerms,
  searchApiPath,
  searchPath,
  type SearchQuery,
  type SearchResultSet,
} from "./searchQuery";
import {
  chipRowStyle,
  chipStyle,
  errorStyle,
  formStyle,
  gridStyle,
  headingStyle,
  iconStyle,
  inputStyle,
  inputWrapStyle,
  pageButtonStyle,
  pageInfoStyle,
  paginationWrapStyle,
  promptStyle,
  statusStyle,
  submitStyle,
} from "./searchStyles";

// How long the input has to be quiet before the query goes out.
//
// The old value was 400ms, inherited from the legacy SPA's SearchBar, and it
// is shorter than the pause a reader takes between two characters of a title.
// Measured by driving a real pinyin IME through 进击的巨人 at three speeds:
//
//   pause between characters      requests at 400-500ms      at 1000ms
//   ------------------------      --------------------      ---------
//   150ms (brisk)                          1                     1
//   400ms (ordinary)                       1                     1
//   800ms (deliberate)                     4                     1
//
// The deliberate row is the complaint this was raised for — one search per
// character, and a grid that churns four times while the reader is still
// typing the name. 1000ms sits above the pause a person actually leaves and
// costs the patient reader ~1.4s from last keystroke to results.
//
// It is a ceiling on waiting, not a floor: Enter, the search button and the
// genre chips all call `run` directly, so nobody who knows what they want has
// to sit through it.
const DEBOUNCE_MS = 1000;

// Result sets held for the session, keyed by queryKey. Backspacing through a
// title is the common case this exists for: every prefix on the way back is
// one the reader just saw, and re-fetching it would be a request whose answer
// is already on the machine. Bounded because a long session on a search page
// is exactly where an unbounded Map stops being a cache.
const RESULT_CACHE_MAX = 60;

// The detail half of the "load failed: …" line when the request never reached
// go-api. Matches the message app/[lang]/search/page.tsx gives its own
// ApiError("NETWORK_ERROR"), so the two paths cannot describe the same failure
// in two vocabularies.
const NETWORK_ERROR = "fetch failed";

function remember(
  cache: Map<string, SearchResultSet>,
  key: string,
  value: SearchResultSet,
): void {
  cache.set(key, value);
  if (cache.size <= RESULT_CACHE_MAX) return;
  // Maps iterate in insertion order, so the first key is the oldest.
  const oldest = cache.keys().next();
  if (!oldest.done) cache.delete(oldest.value);
}

export interface SearchExperienceProps {
  initialQuery: SearchQuery;
  /** The server's answer for initialQuery, or null when it asked for nothing. */
  initialResults: SearchResultSet | null;
  initialError: string | null;
  dict: Dict;
  /** The URL's locale. Card titles follow it; the genre chips follow the cookie. */
  lang: Lang;
}

export default function SearchExperience({
  initialQuery,
  initialResults,
  initialError,
  dict,
  lang,
}: SearchExperienceProps) {
  const locale = useLocale();
  // `dict` is resolved from the URL's locale, so it says zh on a bare path.
  // Chip labels follow the reader's stated preference instead, via useLang():
  // SSR-seeded from the route locale, reconciled to the `lang` cookie after
  // mount — which keeps the chips reading "Action" for English visitors who
  // arrived at a Chinese URL.
  const { lang: viewerLang } = useLang();

  const [q, setQ] = useState(initialQuery.q);
  const [genre, setGenre] = useState(initialQuery.genre);
  // The query the rendered results belong to. Distinct from `q`/`genre`, which
  // are whatever is in the controls this instant — the gap between the two is
  // the debounce window, and every "has anything changed?" decision reads it.
  const [active, setActive] = useState<SearchQuery>(initialQuery);
  const [results, setResults] = useState<SearchResultSet | null>(initialResults);
  const [error, setError] = useState<string | null>(initialError);
  const [pending, setPending] = useState(false);
  // True between compositionstart and compositionend. Nothing is scheduled
  // while it is set: the value in the box during a composition is pinyin, not
  // a title, and searching for it can only ever miss.
  const [composing, setComposing] = useState(false);

  // Adopt a new server render — a real navigation into this route (a shared
  // link opened in place, browser Back into an earlier /search entry). Done
  // during render rather than in an effect because the effect form is what
  // produced the character-eating bug: it also fired on our OWN pushes, and
  // rewound the input to whatever the server had last said.
  //
  // history.replaceState below does not re-render the Server Component, so
  // `initialQuery` changes only when the router genuinely brought a new page.
  const seed = queryKey(initialQuery);
  const [adopted, setAdopted] = useState(seed);
  if (adopted !== seed) {
    setAdopted(seed);
    setQ(initialQuery.q);
    setGenre(initialQuery.genre);
    setActive(initialQuery);
    setResults(initialResults);
    setError(initialError);
    setPending(false);
  }

  const cacheRef = useRef<Map<string, SearchResultSet>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  // Monotonic id of the newest request. A response whose id is stale is
  // dropped: abort covers the network, this covers the gap between a fetch
  // resolving and its `await`ed body parsing.
  const seqRef = useRef(0);

  // Seed the cache with what the server already answered, so returning to the
  // first query after typing past it costs nothing.
  useEffect(() => {
    if (initialResults) remember(cacheRef.current, seed, initialResults);
  }, [seed, initialResults]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (next: SearchQuery) => {
      // The URL moves with the query, not with the response — a reader who
      // copies the address bar mid-flight gets the search they asked for.
      // replaceState, not pushState: one history entry per prefix of a title
      // would make Back a slow-motion replay of the typing.
      window.history.replaceState(null, "", localizeHref(searchPath(next), locale));

      abortRef.current?.abort();
      abortRef.current = null;
      const seq = seqRef.current + 1;
      seqRef.current = seq;

      if (!hasTerms(next)) {
        setActive(next);
        setResults(null);
        setError(null);
        setPending(false);
        return;
      }

      const key = queryKey(next);
      const cached = cacheRef.current.get(key);
      if (cached) {
        setActive(next);
        setResults(cached);
        setError(null);
        setPending(false);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setPending(true);
      try {
        const res = await fetch(searchApiPath(next), {
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          signal: controller.signal,
        });
        const body: unknown = await res.json().catch(() => null);
        if (seqRef.current !== seq) return;
        const parsed = res.ok ? parseSearchResponse(body) : null;
        setActive(next);
        if (parsed) {
          remember(cacheRef.current, key, parsed);
          setResults(parsed);
          setError(null);
        } else {
          // Deliberately keeps nothing on screen from the failed query: a grid
          // left behind under an error line reads as "these are your results".
          setResults(null);
          setError(errorFromResponse(body, res.status));
        }
      } catch {
        // An abort lands here too, and must not paint: the run that aborted
        // this one owns the UI now, and its own state updates are on the way.
        if (seqRef.current !== seq) return;
        setActive(next);
        setResults(null);
        // The same words page.tsx throws for its own NETWORK_ERROR, because
        // the line renders as "<loadError>: <this>" either way and the label
        // is already the translated half. Putting dict.anime.loadError here
        // would print it twice.
        setError(NETWORK_ERROR);
      } finally {
        if (seqRef.current === seq) setPending(false);
      }
    },
    [locale],
  );

  // The debounce. Anything that is not typing — Enter, the button, a genre
  // chip, a page link — calls `run` directly and skips this entirely.
  //
  // The question is sameTERMS, not sameQuery. The controls hold a keyword and
  // a genre and cannot express a page, so comparing the whole query made every
  // page-2 view look like a pending change back to page 1 — and turning the
  // page put the reader back where they started one second later.
  useEffect(() => {
    if (composing) return undefined;
    const next = makeQuery(q, genre, 1);
    if (sameTerms(next, active)) return undefined;
    const timer = setTimeout(() => void run(next), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, genre, composing, active, run]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void run(makeQuery(q, genre, 1));
  };

  const onGenreClick = (g: string) => {
    // A chip toggle is a deliberate filter action, not typing — the reader
    // wants the result now.
    const next = genre === g ? "" : g;
    setGenre(next);
    void run(makeQuery(q, next, 1));
  };

  const onCompositionEnd = (e: CompositionEvent<HTMLInputElement>) => {
    // Read the value here as well as from onChange. Chrome fires `input` after
    // compositionend and Safari fires it before; taking the value from
    // whichever event is last leaves the two browsers agreeing.
    setQ(e.currentTarget.value);
    setComposing(false);
  };

  // Pagination stays anchors — a real href so middle-click and "open in new
  // tab" work and the link is inspectable — but a plain left-click is handled
  // here, without a navigation.
  const onPageClick = (e: MouseEvent<HTMLAnchorElement>, page: number) => {
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    // From `active`, not from the controls: these results belong to the query
    // the server (or the last run) answered, and page 2 of a query the reader
    // has since half-retyped is not a page of anything.
    void run(makeQuery(active.q, active.genre, page));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const heading = buildHeading(active.q, active.genre, dict, lang);
  const showPrompt = !hasTerms(active);
  const rowCount = results?.rows.length ?? 0;
  const totalPages = results?.totalPages ?? 0;
  // Memoised on `results` itself, not on a `results?.rows ?? []` fallback: the
  // fallback is a fresh array on every render, so the memo would rebuild all
  // twenty cards each time `pending` flips.
  const cards = useMemo(
    () =>
      (results?.rows ?? []).map((a) => {
        // SearchRow lacks `genres` — AnimeCard treats it as optional and
        // degrades gracefully (no chip overlay).
        const cardData: AnimeCardData = {
          anilistId: a.anilistId,
          titleChinese: a.titleChinese,
          titleHant: a.titleHant,
          titleRomaji: a.titleRomaji,
          titleEnglish: a.titleEnglish,
          titleNative: a.titleNative,
          coverImageUrl: a.coverImageUrl,
          posterAccent: a.posterAccent,
          averageScore: a.averageScore,
          format: a.format,
        };
        return <AnimeCard key={a.anilistId} anime={cardData} lang={lang} prefetch={false} />;
      }),
    [results, lang],
  );

  return (
    <>
      <style>{`
        .search-input:focus-visible {
          outline: none;
          border-color: #0a84ff;
          box-shadow: 0 0 0 3px rgba(10,132,255,0.40);
        }
        .search-chip:focus-visible,
        .search-submit:focus-visible,
        .search-page:focus-visible {
          outline: none;
          box-shadow: 0 0 0 3px rgba(10,132,255,0.40);
        }
        .search-anime-grid {
          grid-template-columns: repeat(5, 1fr);
        }
        @media (max-width: 900px) {
          .search-anime-grid { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 600px) {
          .search-anime-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          .search-results { transition: none !important; }
        }
      `}</style>

      <h1 style={headingStyle}>{heading}</h1>

      {/* A real GET form, not just an onSubmit handler.
          The window it covers is between the form appearing on screen and
          React hydrating it. Those are not the same instant: this route
          streams (it has a loading.tsx, so the shell arrives first and the
          inline $RC script reveals the content), and hydration lands some way
          behind that. Type in the gap and every keystroke goes into the DOM
          and nowhere else — verified by accident while writing the probe for
          this change, which typed too early and watched React discard the lot.
          With name= and action= set, Enter in that window is instead a plain
          navigation to /search?q=…, a page this route already renders.
          onSubmit preventDefaults it once React is listening.
          Not a no-JS story: with scripts off entirely, $RC never runs and the
          reader never sees this form at all. */}
      <form
        style={formStyle}
        onSubmit={onSubmit}
        role="search"
        method="get"
        action={localizeHref("/search", locale)}
      >
        <div style={inputWrapStyle}>
          <span style={iconStyle} aria-hidden>
            #
          </span>
          <input
            className="search-input"
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={onCompositionEnd}
            // The safety valve. `composing` suppresses scheduling, so a
            // compositionstart whose compositionend never arrives would stop
            // search working at all, silently, for the rest of the page's
            // life. Leaving the field ends any composition as far as this
            // component is concerned, and gives that state one guaranteed way
            // back to false that does not depend on the IME.
            onBlur={() => setComposing(false)}
            placeholder={dict.search.placeholder}
            aria-label={dict.search.title}
            style={inputStyle}
          />
        </div>
        {/* Only when set, so the no-JS submit produces /search?q=… rather than
            a trailing "&genre=". Chips are type="button" and never submit. */}
        {genre ? <input type="hidden" name="genre" value={genre} readOnly /> : null}
        <button type="submit" className="search-submit" style={submitStyle}>
          {dict.nav.search}
        </button>
        {/* Reserves its own row space at all times so the grid below does not
            shift when the word appears. */}
        <span role="status" aria-live="polite" style={statusStyle}>
          {pending ? dict.search.searching : ""}
        </span>
      </form>

      <div style={chipRowStyle} role="group" aria-label="genre filter">
        {FILTER_GENRES.map((g) => {
          const active_ = genre === g;
          return (
            <button
              key={g}
              type="button"
              className="search-chip"
              // onGenreClick receives the raw enum: only the label is
              // translated, ?genre= stays English so links keep resolving.
              onClick={() => onGenreClick(g)}
              style={chipStyle(active_)}
              aria-pressed={active_}
            >
              {genreLabel(g, viewerLang)}
            </button>
          );
        })}
      </div>

      {showPrompt ? (
        <div style={promptStyle}>{dict.search.prompt}</div>
      ) : (
        // One provider for the whole result area, mounted for as long as the
        // page has a query. Keeping it above the results means swapping them
        // does not re-run its GET /api/subscriptions — the reader's list is
        // fetched once per visit however many searches they run.
        <SubscriptionSetProvider>
          <div
            className="search-results"
            aria-busy={pending}
            style={{
              opacity: pending ? 0.45 : 1,
              transition: "opacity 160ms ease",
            }}
          >
            {error ? (
              <div style={errorStyle}>
                {dict.anime.loadError}: {error}
              </div>
            ) : rowCount === 0 ? (
              <div style={promptStyle}>{pending ? "" : dict.anime.noAnime}</div>
            ) : (
              <div className="search-anime-grid" style={gridStyle}>
                {cards}
              </div>
            )}
          </div>

          {totalPages > 1 ? (
            <nav style={paginationWrapStyle} aria-label="search pagination">
              <PageLink
                to={active.page - 1}
                enabled={active.page > 1}
                label={dict.search.prev}
                query={active}
                onClick={onPageClick}
              />
              <span style={pageInfoStyle}>
                <span style={{ color: "#ffffff", fontWeight: 700 }}>{active.page}</span>
                {" / "}
                {totalPages}
              </span>
              <PageLink
                to={active.page + 1}
                enabled={active.page < totalPages}
                label={dict.search.next}
                query={active}
                onClick={onPageClick}
              />
            </nav>
          ) : null}
        </SubscriptionSetProvider>
      )}
    </>
  );
}

interface PageLinkProps {
  to: number;
  enabled: boolean;
  label: string;
  query: SearchQuery;
  onClick: (e: MouseEvent<HTMLAnchorElement>, page: number) => void;
}

function PageLink({ to, enabled, label, query, onClick }: PageLinkProps) {
  if (!enabled) {
    return (
      <span style={pageButtonStyle(true)} aria-disabled>
        {label}
      </span>
    );
  }
  return (
    <Link
      className="search-page"
      href={searchPath(makeQuery(query.q, query.genre, to))}
      prefetch={false}
      style={pageButtonStyle(false)}
      onClick={(e) => onClick(e, to)}
    >
      {label}
    </Link>
  );
}
