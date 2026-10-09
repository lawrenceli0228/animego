"use client";

// The 角色 tab's list: the role filter (全部 / 主角 / 配角 / 客串), the dub
// switch (日配 / 中配 / 韩配, only the ones the title has), a search over
// character and voice-actor names, and the card grid with 「再显示 N 位」.
//
// The server renders the first page with the default filters into the
// cached HTML, which is what a crawler and a first paint see. Every change
// after that is a request to /api/anime/:id/characters from the browser —
// the filters and the search are server-side, so a 400-character title
// never ships its whole cast to the page.
//
// No card links anywhere: the character and person pages do not exist yet,
// and a link that 404s is worse than none.

import { useCallback, useEffect, useRef, useState, type CompositionEvent } from "react";
import FadeImage from "@/components/ui/FadeImage";
import { apiGetEnvelope } from "@/lib/api";
import {
  CAST_FIRST_PAGE,
  CAST_MORE_PAGE,
  DUB_LABEL,
  ROLE_FILTERS,
  appendCastPage,
  castCardView,
  characterRoleLabel,
  charactersQuery,
  roleCount,
  type RoleFilter,
} from "@/lib/detail/cast";
import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import type { CharactersResponse, DubLanguage } from "@/lib/types";
import s from "./CharacterBrowser.module.css";

/** Typing settles for this long before the list is asked again. */
const SEARCH_DEBOUNCE_MS = 250;

/** Portraits: the card's 64x96 on a desktop; Next derives the 2x from it. */
const PORTRAIT_W = 64;
const PORTRAIT_H = 96;

type Status = "idle" | "loading" | "error";

interface Filters {
  role: RoleFilter;
  dub: DubLanguage;
  query: string;
}

export default function CharacterBrowser({
  anilistId,
  initial,
}: {
  anilistId: number;
  /** The first page the server rendered, with the default filters. */
  initial: CharactersResponse;
}) {
  const { lang, t } = useLang();
  // What the controls show. The list below follows once its request lands.
  const [filters, setFilters] = useState<Filters>(() => ({ role: "all", dub: initial.language, query: "" }));
  const [input, setInput] = useState("");
  // True between compositionstart and compositionend: the box holds pinyin
  // or kana being composed, not a name, and searching for it can only miss
  // (the search page learned this in #129).
  const [composing, setComposing] = useState(false);
  // The list on screen and the filters it was fetched with. They change
  // together, so a slow response can never paint one filter's cards under
  // another filter's chips.
  const [shown, setShown] = useState<{ filters: Filters; data: CharactersResponse }>(() => ({
    filters: { role: "all", dub: initial.language, query: "" },
    data: initial,
  }));
  const [status, setStatus] = useState<Status>("idle");
  const [moreStatus, setMoreStatus] = useState<Status>("idle");
  const abortRef = useRef<AbortController | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);
  // The newest list request. A response for an older one is dropped: abort
  // covers the network, this covers a body already being parsed.
  const seqRef = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  // The card focus moves to once a page 「再显示」 asked for is on screen.
  const focusCardRef = useRef<number | null>(null);

  const pathFor = useCallback(
    (f: Filters, offset: number, limit: number) =>
      `/api/anime/${anilistId}/characters?${charactersQuery({
        role: f.role,
        dub: f.dub,
        q: f.query,
        offset,
        limit,
      })}`,
    [anilistId],
  );

  /** Replace the list with the first page for `next`. */
  const run = useCallback(
    async (next: Filters) => {
      setFilters(next);
      abortRef.current?.abort();
      moreAbortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      setStatus("loading");
      setMoreStatus("idle");
      try {
        const data = await apiGetEnvelope<CharactersResponse>(pathFor(next, 0, CAST_FIRST_PAGE), {
          signal: controller.signal,
        });
        if (seqRef.current !== seq) return;
        setShown({ filters: next, data });
        setStatus("idle");
      } catch {
        // An abort lands here too, and must not paint: the run that aborted
        // this one owns the list now.
        if (seqRef.current !== seq) return;
        setStatus("error");
      }
    },
    [pathFor],
  );

  // The search box settles before it filters, and never mid-composition. The
  // effect only schedules the request; `run` is what changes anything.
  useEffect(() => {
    if (composing) return undefined;
    const next = input.trim();
    if (next === filters.query) return undefined;
    const timer = window.setTimeout(() => void run({ ...filters, query: next }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input, composing, filters, run]);

  const onCompositionEnd = (e: CompositionEvent<HTMLInputElement>) => {
    // Chrome fires `input` after compositionend and Safari before it; reading
    // the value here too leaves the two agreeing (as the search page does).
    setInput(e.currentTarget.value);
    setComposing(false);
  };

  useEffect(
    () => () => {
      abortRef.current?.abort();
      moreAbortRef.current?.abort();
    },
    [],
  );

  // After 「再显示」 from the keyboard, focus moves to the first card it added:
  // reading on from there is reading what was asked for, the button is one
  // Tab further, and on the last page — where the button goes away — focus
  // would otherwise fall back to the top of the page.
  useEffect(() => {
    const index = focusCardRef.current;
    if (index === null) return;
    focusCardRef.current = null;
    const card = listRef.current?.children.item(index);
    if (card instanceof HTMLElement) card.focus({ preventScroll: true });
  }, [shown]);

  const list = shown.data;
  const remaining = Math.max(0, list.total - list.data.length);

  /**
   * Append the next page of the list on screen. `refocus`: the button had
   * focus when it was pressed, and focus follows the new cards.
   */
  const loadMore = async (refocus: boolean) => {
    if (moreStatus === "loading" || status === "loading" || remaining === 0) return;
    moreAbortRef.current?.abort();
    const controller = new AbortController();
    moreAbortRef.current = controller;
    const seq = seqRef.current;
    const firstNew = list.data.length;
    setMoreStatus("loading");
    try {
      const page = await apiGetEnvelope<CharactersResponse>(
        pathFor(shown.filters, list.data.length, CAST_MORE_PAGE),
        { signal: controller.signal },
      );
      // A filter changed meanwhile: that list owns the screen now.
      if (seqRef.current !== seq || controller.signal.aborted) return;
      if (refocus) focusCardRef.current = firstNew;
      setShown((cur) => ({
        filters: cur.filters,
        data: { ...page, offset: 0, data: appendCastPage(cur.data.data, page.data) },
      }));
      setMoreStatus("idle");
    } catch {
      if (seqRef.current !== seq || controller.signal.aborted) return;
      setMoreStatus("error");
    }
  };

  const setRole = (role: RoleFilter) => {
    if (role !== filters.role) void run({ ...filters, role });
  };
  const setDub = (dub: DubLanguage) => {
    if (dub !== filters.dub) void run({ ...filters, dub });
  };

  const roleLabel = (filter: RoleFilter) =>
    filter === "all" ? t("detail.filterAll") : characterRoleLabel(filter, lang);
  const languages = list.counts.languages;
  const busy = status === "loading";
  const searching = shown.filters.query !== "";

  return (
    <section className={s.root} aria-labelledby="cast-heading">
      <h2 className={s.srOnly} id="cast-heading">
        {t("detail.castHeading")}
      </h2>

      {/* Announces the result of a filter, a search or 「再显示」. Polite, and
          only the number: the list itself is right there. */}
      <p className={s.srOnly} aria-live="polite">
        {busy ? "" : fillTemplate(t("detail.resultCount"), { n: list.total })}
      </p>

      <div className={s.toolbar}>
        <div className={s.seg} role="group" aria-label={t("detail.roleFilterAria")}>
          {ROLE_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              className={s.segButton}
              aria-pressed={filters.role === filter}
              onClick={() => setRole(filter)}
            >
              {roleLabel(filter)} <span className={s.segCount}>{roleCount(list.counts.roles, filter)}</span>
            </button>
          ))}
        </div>

        {languages.length > 0 ? (
          <div className={s.seg} role="group" aria-label={t("detail.dubFilterAria")}>
            {languages.map(({ language, count }) => (
              <button
                key={language}
                type="button"
                className={s.segButton}
                aria-pressed={filters.dub === language}
                onClick={() => setDub(language)}
              >
                {DUB_LABEL[lang][language]} <span className={s.segCount}>{count}</span>
              </button>
            ))}
          </div>
        ) : null}

        <label className={s.searchBox}>
          <svg className={s.searchIcon} viewBox="0 0 24 24" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            className={s.searchInput}
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={onCompositionEnd}
            // A compositionend that never comes must not stop the search for
            // good: leaving the field ends the composition as far as we care.
            onBlur={() => setComposing(false)}
            placeholder={t("detail.searchCast")}
            aria-label={t("detail.searchCast")}
            maxLength={64}
            enterKeyHint="search"
          />
        </label>
      </div>

      {status === "error" ? (
        <div className={s.empty} role="alert">
          <p className={s.emptyText}>{t("detail.listFailed")}</p>
          <button type="button" className={s.retry} onClick={() => void run(filters)}>
            {t("detail.retry")}
          </button>
        </div>
      ) : list.data.length === 0 ? (
        <div className={s.empty}>
          <p className={s.emptyText}>
            {searching || shown.filters.role !== "all" ? t("detail.castEmpty") : t("detail.castNone")}
          </p>
        </div>
      ) : (
        <ul ref={listRef} className={s.grid} aria-busy={busy} data-busy={busy ? "true" : undefined}>
          {list.data.map((c, i) => {
            const card = castCardView(c, list.language, lang, i);
            return (
              <li key={card.key} className={s.card} tabIndex={-1}>
                {/* alt="": the name is the next thing read, and a portrait named
                    after it would be read twice. */}
                <FadeImage
                  src={card.imageUrl}
                  alt=""
                  width={PORTRAIT_W}
                  height={PORTRAIT_H}
                  className={s.charImg}
                />
                <div className={s.side}>
                  <div className={s.names}>
                    <div className={s.name}>{card.name}</div>
                    {card.altName ? <div className={s.alt}>{card.altName}</div> : null}
                  </div>
                  <div className={s.role} data-main={card.isMain ? "true" : undefined}>
                    {card.roleLabel}
                  </div>
                </div>
                {card.voice ? (
                  <>
                    <div className={s.sideVa}>
                      <div className={s.names}>
                        <div className={s.name}>{card.voice.name}</div>
                        {card.voice.altName ? <div className={s.alt}>{card.voice.altName}</div> : null}
                      </div>
                      <div className={s.note}>{card.note}</div>
                    </div>
                    {/* In a slot of its own: FadeImage draws a missing portrait as
                        a block with an inline display, which no stylesheet rule
                        can hide, and the phone list has no portrait here. */}
                    <div className={s.vaImgSlot}>
                      <FadeImage
                        src={card.voice.imageUrl}
                        alt=""
                        width={PORTRAIT_W}
                        height={PORTRAIT_H}
                        className={s.vaImg}
                      />
                    </div>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {status !== "error" && remaining > 0 ? (
        <button
          type="button"
          className={s.loadMore}
          onClick={(e) => void loadMore(e.currentTarget === document.activeElement)}
          // aria-disabled, not disabled: a disabled button drops the focus
          // it holds, and the keyboard user who pressed it would land at the
          // top of the page. loadMore ignores a press while it is busy.
          aria-disabled={moreStatus === "loading" || busy}
          aria-busy={moreStatus === "loading"}
        >
          {moreStatus === "loading"
            ? t("detail.listLoading")
            : moreStatus === "error"
              ? t("detail.listFailed")
              : fillTemplate(t("detail.showMore"), { n: Math.min(CAST_MORE_PAGE, remaining) })}
        </button>
      ) : null}
    </section>
  );
}
