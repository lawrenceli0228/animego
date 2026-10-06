"use client";

// The homepage hero: the season's top five, one in focus at a time.
//
// Seanime-style composition: the focused cover blurred into ambient light
// behind everything, its banner fading in from the right, a small cover and a
// few lines of text on the left.
//
// No autoplay. DESIGN.md forbids auto-rotating carousels, and the old one's
// rotation was also what yanked readers back up the page. Switching is five
// short bars, each in its own anime's colour.
//
// All five slides stay mounted and stacked, and a switch is CSS transitions
// only — banner crossfade, the cover popping in, the title's tokens un-blurring
// one by one, the text lines sliding in. Nothing remounts, so nothing refetches
// and nothing flashes. The page colour follows along through HomeHueScope.
//
// Banners are the heaviest images on the page, so a slide's banner is only
// rendered once it is in focus or has been hovered/focused toward — the first
// paint fetches one banner, not five.

import { getImageProps } from "next/image";
import Link from "@/components/ui/LocaleLink";
import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { heroStatusParts, statusText } from "@/lib/home/heroStatus";
import { fillTemplate, weekdayTime } from "@/lib/home/time";
import { tokenDelays } from "@/lib/home/titleTokens";
import { cardToneVars, toneLadder } from "@/lib/home/tone";
import type { HeroSlide } from "@/lib/home/viewModels";
import { useLang } from "@/lib/lang-client";
import HeroFollowButton from "./HeroFollowButton";
import { useHeroFocus } from "./HomeHueScope";
import { ArrowIcon, StarIcon } from "./icons";
import { useHomeClock } from "./useHomeClock";
import styles from "./HomeHero.module.css";

interface HomeHeroProps {
  slides: HeroSlide[];
  /** The server's render time, so the first paint's status line is already right. */
  serverNowMs: number;
  /** anilistId → current episode, for the signed-in reader's "已追 · 第 N 集". */
  progress: Record<number, number>;
}

// Same image conventions as the rest of the site (see FadeImage): through the
// optimizer, quality 85 (AVIF q65). Covers at their rendered size; banners at
// their native 1900px, because object-fit: cover scales a 4.75:1 banner to
// ~2300px wide in a 484px-tall hero — anything smaller is upscaled.
function coverProps(src: string) {
  return getImageProps({ src, alt: "", width: 196, height: 276, quality: 85 }).props;
}

function bannerProps(src: string, isBanner: boolean) {
  return isBanner
    ? getImageProps({ src, alt: "", width: 1900, height: 400, quality: 85 }).props
    : getImageProps({ src, alt: "", width: 460, height: 650, quality: 85 }).props;
}

type Vars = CSSProperties & Record<`--${string}`, string>;

export default function HomeHero({ slides, serverNowMs, progress }: HomeHeroProps) {
  const { lang, t } = useLang();
  const { active, setActive } = useHeroFocus();
  const { nowMs, timeZone } = useHomeClock(serverNowMs);
  // Flips on the first switch: the entrance animations belong to the first
  // paint only, and the live region should stay silent until someone acts.
  const [switched, setSwitched] = useState(false);
  const [warm, setWarm] = useState<ReadonlySet<number>>(() => new Set([0]));
  const barRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const count = slides.length;
  if (count === 0) return null;
  const current = Math.min(active, count - 1);

  const warmUp = (index: number) => {
    if (warm.has(index)) return;
    setWarm((prev) => new Set(prev).add(index));
  };

  const pick = (index: number) => {
    warmUp(index);
    if (index === current) return;
    setActive(index);
    setSwitched(true);
  };

  // Arrow keys move between the bars, as they would in any segmented control.
  // Only these keys are handled — swallowing everything would trap Tab.
  const onBarsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (current + 1) % count
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (current - 1 + count) % count
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    pick(next);
    barRefs.current[next]?.focus();
  };

  const statusCopy = { epUpdate: t("home.heroEpUpdate"), totalEps: t("home.heroTotalEps") };
  const when = (ms: number) => weekdayTime(ms, timeZone, lang);

  return (
    <section className={styles.hero} aria-label={t("home.heroLabel")} data-entered={switched ? "true" : "false"}>
      <div className={styles.glow} aria-hidden>
        <div className={styles.glowInner}>
          {slides.map((s, i) =>
            s.cover ? (
              // eslint-disable-next-line @next/next/no-img-element -- optimised via getImageProps; a plain <img> keeps several stacked per slot
              <img
                key={s.id}
                {...coverProps(s.cover)}
                alt=""
                className={styles.glowImg}
                data-active={i === current}
                loading={i === 0 ? "eager" : "lazy"}
                decoding="async"
              />
            ) : null,
          )}
        </div>
      </div>

      {slides.map((s, i) => (
        <div key={s.id} className={styles.banner} data-active={i === current} aria-hidden>
          {s.banner && (warm.has(i) || i === current) ? (
            <div className={styles.bannerIn}>
              {/* eslint-disable-next-line @next/next/no-img-element -- optimised via getImageProps; a plain <img> keeps several stacked per slot */}
              <img
                {...bannerProps(s.banner, s.hasBanner)}
                alt=""
                className={styles.bannerImg}
                data-cover={s.hasBanner ? undefined : "true"}
                loading={i === 0 ? "eager" : "lazy"}
                fetchPriority={i === 0 ? "high" : "auto"}
                decoding={i === 0 ? "sync" : "async"}
              />
            </div>
          ) : null}
        </div>
      ))}

      <div className={styles.topShade} aria-hidden />
      <div className={styles.scrim} aria-hidden />

      <div className={styles.content}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowLabel} aria-hidden>
            {t("home.heroLabel")}
          </span>
          <div className={styles.bars} role="group" aria-label={t("home.heroLabel")} onKeyDown={onBarsKeyDown}>
            {slides.map((s, i) => {
              const tone = toneLadder(s.hue);
              const vars: Vars = { "--bar-on": tone.text, "--bar-off": tone.line };
              return (
                <button
                  key={s.id}
                  ref={(el) => {
                    barRefs.current[i] = el;
                  }}
                  type="button"
                  className={styles.bar}
                  style={vars}
                  aria-pressed={i === current}
                  aria-label={fillTemplate(t("home.heroPick"), { n: i + 1, title: s.title })}
                  onClick={() => pick(i)}
                  onPointerEnter={() => warmUp(i)}
                  onFocus={() => warmUp(i)}
                >
                  <span className={styles.barFill} />
                  <span className={styles.barTip} aria-hidden>
                    {s.title}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.stage}>
          <div className={styles.covers} aria-hidden>
            {slides.map((s, i) => {
              const vars = cardToneVars(s.hue) as unknown as Vars;
              return s.cover ? (
                // eslint-disable-next-line @next/next/no-img-element -- optimised via getImageProps; a plain <img> keeps several stacked per slot
                <img
                  key={s.id}
                  {...coverProps(s.cover)}
                  alt=""
                  className={styles.cover}
                  style={vars}
                  data-active={i === current}
                  loading={i === 0 ? "eager" : "lazy"}
                  fetchPriority={i === 0 ? "high" : "auto"}
                  decoding="async"
                />
              ) : (
                <span key={s.id} className={styles.cover} style={vars} data-active={i === current} />
              );
            })}
          </div>

          {slides.map((s, i) => {
            const isActive = i === current;
            const tone = toneLadder(s.hue);
            const vars: Vars = {
              "--tone": tone.text,
              "--tone-fill": tone.fill,
              "--on-solid": tone.onSolid,
            };
            const parts = heroStatusParts(
              { status: s.status, statusLabel: s.statusLabel, episodes: s.episodes, airings: s.airings },
              nowMs,
              when,
              statusCopy,
            );
            const longStatus = statusText(parts);
            const shortStatus = statusText(parts, { short: true });
            return (
              <article
                key={s.id}
                className={styles.slide}
                style={vars}
                data-active={isActive}
                aria-hidden={!isActive}
                inert={!isActive}
              >
                <div className={styles.head}>
                  <h2 className={styles.title}>
                    <span className={styles.srOnly}>{s.title}</span>
                    <span aria-hidden>
                      {s.tokens.map((token, k) => {
                        const d = tokenDelays(k);
                        const tv: Vars = { "--td": `${d.switchMs}ms`, "--ld": `${d.entryMs}ms` };
                        return (
                          <span key={k} className={styles.tok} style={tv}>
                            {token}
                          </span>
                        );
                      })}
                    </span>
                  </h2>
                  {s.genres.length > 0 ? (
                    <p className={`${styles.genres} ${styles.line} ${styles.l1}`}>
                      {s.genres.map((g) => (
                        <span key={g}>{g}</span>
                      ))}
                    </p>
                  ) : null}
                  {s.score || longStatus ? (
                    <div className={`${styles.meta} ${styles.line} ${styles.l2}`}>
                      {s.score ? (
                        <span className={styles.score}>
                          <StarIcon />
                          <span className={styles.mono}>{s.score}</span>
                        </span>
                      ) : null}
                      {longStatus ? (
                        <span className={styles.status}>
                          <span className={styles.dot} data-live={parts.live} aria-hidden />
                          <span className={styles.statusLong}>{longStatus}</span>
                          <span className={styles.statusShort}>{shortStatus}</span>
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {s.synopsis ? <p className={`${styles.synopsis} ${styles.line} ${styles.l3}`}>{s.synopsis}</p> : null}
                <div className={`${styles.actions} ${styles.line} ${styles.l4}`}>
                  <Link href={s.href} prefetch={false} className={styles.solid}>
                    {t("detail.viewDetails")}
                    <ArrowIcon className={styles.arrow} />
                  </Link>
                  <HeroFollowButton
                    anilistId={s.id}
                    title={s.title}
                    progress={progress[s.id]}
                    className={styles.glass}
                  />
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <p className={styles.srOnly} aria-live="polite">
        {switched ? `${current + 1} / ${count}: ${slides[current].title}` : ""}
      </p>
    </section>
  );
}
