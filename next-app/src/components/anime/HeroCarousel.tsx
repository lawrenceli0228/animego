"use client";

import Link from "@/components/ui/LocaleLink";
import { genreLabel } from "@/lib/contentLabels";
import { pickTitle, stripHtml, truncate } from "@/lib/formatters";
import type { Dict, Lang } from "@/lib/i18n";
import { useLang } from "@/lib/lang-client";
import type { SeasonalAnime } from "@/lib/types";
import type { CSSProperties, FocusEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./HeroCarousel.module.css";

const INTERVAL_MS = 5000;

type CarouselAnime = SeasonalAnime & {
  bannerImageUrl?: string | null;
  description?: string | null;
  genres?: string[];
};

export interface HeroCarouselProps {
  animeList: CarouselAnime[];
  dict: Dict;
  lang: Lang;
}

type SeasonKey = "WINTER" | "SPRING" | "SUMMER" | "FALL";

function seasonLabel(dict: Dict, season: string | null | undefined): string {
  if (!season) return "";
  const key = season.toUpperCase() as SeasonKey;
  if (key === "WINTER" || key === "SPRING" || key === "SUMMER" || key === "FALL") {
    return dict.season[key];
  }
  return season;
}

function hexToRgb(value: string | null | undefined): string {
  const hex = value?.trim().replace(/^#/, "");
  if (!hex || !/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) return "96, 165, 250";
  const normalized = hex.length === 3 ? [...hex].map((part) => part + part).join("") : hex;
  return [0, 2, 4]
    .map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16))
    .join(", ");
}

type HeroVariables = CSSProperties & {
  "--hero-accent": string;
  "--hero-accent-rgb": string;
};

export default function HeroCarousel({ animeList, dict, lang }: HeroCarouselProps) {
  const { lang: viewerLang, t } = useLang();
  const [current, setCurrent] = useState(0);
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const [temporarilyPaused, setTemporarilyPaused] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const remainingRef = useRef(INTERVAL_MS);
  const activeRailRef = useRef<HTMLButtonElement | null>(null);

  const len = animeList.length;
  const currentIndex = current < len ? current : 0;
  const isPaused = manuallyPaused || temporarilyPaused || prefersReducedMotion;

  const show = useCallback(
    (index: number) => {
      if (len === 0) return;
      remainingRef.current = INTERVAL_MS;
      setCurrent((index + len) % len);
    },
    [len],
  );

  const next = useCallback(() => show(currentIndex + 1), [currentIndex, show]);
  const previous = useCallback(() => show(currentIndex - 1), [currentIndex, show]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setPrefersReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    remainingRef.current = INTERVAL_MS;
  }, [currentIndex, len]);

  useEffect(() => {
    if (isPaused || len < 2) return;

    const remaining = remainingRef.current;
    const startedAt = window.performance.now();
    const timer = window.setTimeout(next, remaining);

    return () => {
      window.clearTimeout(timer);
      const elapsed = window.performance.now() - startedAt;
      remainingRef.current = Math.max(0, remaining - elapsed);
    };
  }, [currentIndex, isPaused, len, next]);

  // Centre the active item in the rail's own scroller — and nothing else.
  //
  // This was `activeRailRef.current.scrollIntoView({block: "nearest", inline:
  // "center"})`, which walks EVERY scrollable ancestor, the document included.
  // The intent was only ever the rail's horizontal overflow (it scrolls at
  // ≤900px; above that the five items are a grid that fits). What it actually
  // did was scroll the page: a reader who had scrolled past the hero got yanked
  // back to it on the next rotation, every five seconds. `block: "nearest"` is
  // a no-op when the element is already visible, which is exactly why this
  // survived review — it is invisible until someone scrolls away and waits.
  //
  // Setting scrollLeft on the container cannot move anything but the container.
  useEffect(() => {
    const item = activeRailRef.current;
    const list = item?.parentElement;
    if (!item || !list) return;
    if (list.scrollWidth <= list.clientWidth) return;

    const centred = item.offsetLeft - (list.clientWidth - item.clientWidth) / 2;
    list.scrollTo({
      left: Math.max(0, Math.min(centred, list.scrollWidth - list.clientWidth)),
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }, [currentIndex, prefersReducedMotion]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        previous();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      }
    },
    [next, previous],
  );

  const onBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setTemporarilyPaused(false);
  }, []);

  if (len === 0) return null;

  const activeAnime = animeList[currentIndex] ?? animeList[0];
  // Drives atmosphere only — the eyebrow rule, the progress bar, hover washes.
  // The primary button deliberately does not read this; see .primaryAction in
  // the stylesheet for why. Falls back to the system accent so a cover with no
  // extracted colour still looks like this site rather than a near-miss blue.
  const activeAccent = activeAnime.posterAccent || "#0a84ff";
  const activeTitle = pickTitle(activeAnime, lang);
  const heroVariables: HeroVariables = {
    "--hero-accent": activeAccent,
    "--hero-accent-rgb": hexToRgb(activeAccent),
  };

  return (
    <section
      className={styles.root}
      style={heroVariables}
      data-paused={isPaused}
      onMouseEnter={() => setTemporarilyPaused(true)}
      onMouseLeave={() => setTemporarilyPaused(false)}
      onFocusCapture={() => setTemporarilyPaused(true)}
      onBlurCapture={onBlurCapture}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="region"
      aria-roledescription="carousel"
      aria-label="Featured anime carousel"
    >
      {animeList.map((anime, index) => {
        const isActive = index === currentIndex;
        const inWindow =
          index === currentIndex ||
          index === (currentIndex + 1) % len ||
          index === (currentIndex - 1 + len) % len;
        const desktopArt = anime.bannerImageUrl || anime.coverImageUrl || "";
        const mobileArt = anime.coverImageUrl || desktopArt;
        const title = pickTitle(anime, lang);
        const description = anime.description
          ? truncate(stripHtml(anime.description), 130)
          : null;

        return (
          <article
            key={anime.anilistId}
            className={`${styles.slide} ${isActive ? styles.slideActive : ""}`}
            aria-hidden={!isActive}
            inert={!isActive}
          >
            {desktopArt && inWindow ? (
              <picture className={styles.artwork}>
                {mobileArt ? <source media="(max-width: 680px)" srcSet={mobileArt} /> : null}
                <img
                  className={styles.art}
                  src={desktopArt}
                  alt=""
                  aria-hidden
                  loading={index === 0 ? "eager" : "lazy"}
                  fetchPriority={index === 0 ? "high" : "auto"}
                  decoding={index === 0 ? "sync" : "async"}
                />
              </picture>
            ) : (
              <div className={`${styles.artwork} ${styles.placeholder}`} aria-hidden />
            )}

            <div className={styles.copy}>
              {anime.season && anime.seasonYear ? (
                <p className={styles.eyebrow}>
                  {anime.seasonYear} {seasonLabel(dict, anime.season)} · Seasonal focus
                </p>
              ) : null}

              <h2 className={styles.title}>{title}</h2>

              {/* Genre only. The score and the format code were here too, and
                * both answer a question nobody is asking yet: this is the
                * moment someone decides whether they care about the show at
                * all, and "8.2" and "TV" do not help with that while a genre
                * does. They are one click away on the detail page, where the
                * question they answer is the one being asked. */}
              <div className={styles.metaRow}>
                {anime.genres?.slice(0, 2).map((genre) => (
                  <span key={genre} className={styles.metaChip}>
                    {genreLabel(genre, viewerLang)}
                  </span>
                ))}
              </div>

              {description ? <p className={styles.description}>{description}</p> : null}

              <div className={styles.actions}>
                <Link
                  href={`/anime/${anime.anilistId}`}
                  prefetch={false}
                  className={styles.primaryAction}
                >
                  {dict.detail.viewDetails}
                  <span aria-hidden>→</span>
                </Link>
                <Link href="/player" prefetch={false} className={styles.secondaryAction}>
                  <span aria-hidden>▶</span>
                  {t("playerGuide.trialCta")}
                </Link>
              </div>
            </div>
          </article>
        );
      })}

      {/* Position, not mechanism. "01 / 05" tells a reader how much is here and
        * where they are in it. The rotation interval told them how the
        * component was built, which is our concern rather than theirs — and it
        * sat in the most expensive pixels on the site to say it. The pause
        * control below carries the only part of that state anyone can act on. */}
      {/* The "03 / 05" counter and the rotated "AnimeGoClub · Seasonal Pickup"
        * label both used to sit here. Both were saying something already said
        * better a few pixels away.
        *
        * The rail along the bottom names every title in the rotation and marks
        * the one you are on, so it strictly contains what the counter said. And
        * the eyebrow reads "2026 夏季 · SEASONAL FOCUS" in the reading
        * direction, while the side label said the same thing turned ninety
        * degrees, where it could be seen but not read.
        *
        * Neither removal costs information. They cost twelve competing elements
        * in one viewport becoming nine. */}

      <button
        type="button"
        className={`${styles.arrow} ${styles.previous}`}
        onClick={previous}
        aria-label="Previous slide"
      >
        ‹
      </button>
      <button
        type="button"
        className={`${styles.arrow} ${styles.next}`}
        onClick={next}
        aria-label="Next slide"
      >
        ›
      </button>

      <div className={styles.rail}>
        <div className={styles.railList} role="tablist" aria-label="Featured anime">
          {animeList.map((anime, index) => {
            const isActive = index === currentIndex;
            return (
              <button
                key={anime.anilistId}
                ref={isActive ? activeRailRef : undefined}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={`Slide ${index + 1}: ${pickTitle(anime, lang)}`}
                className={`${styles.railItem} ${isActive ? styles.railItemActive : ""}`}
                onClick={() => show(index)}
              >
                <span className={styles.railNumber}>{String(index + 1).padStart(2, "0")}</span>
                <span className={styles.railTitle}>{pickTitle(anime, lang)}</span>
                <span className={styles.railProgress} aria-hidden />
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className={styles.pauseButton}
          onClick={() => setManuallyPaused((value) => !value)}
          aria-label={manuallyPaused ? "Resume auto rotation" : "Pause auto rotation"}
          aria-pressed={manuallyPaused}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            {manuallyPaused ? (
              <path d="m8 5 11 7-11 7V5Z" />
            ) : (
              <path d="M7 5h3v14H7V5Zm7 0h3v14h-3V5Z" />
            )}
          </svg>
        </button>
      </div>

      <p className={styles.srOnly} aria-live="polite">
        {currentIndex + 1} / {len}: {activeTitle}
      </p>
    </section>
  );
}
