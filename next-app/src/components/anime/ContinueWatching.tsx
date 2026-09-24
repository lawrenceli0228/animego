// 继续看 — the signed-in reader's watching list, first on the homepage after
// the hero. Server component: the data is fetched by the page (in parallel
// with everything else, not as a second round trip after it) and passed in.
//
// Three states, as before:
//   - anonymous (401/network)  → the 我的库 explainer, with a log-in CTA
//   - signed in, nothing       → the same explainer, pointing at the library
//   - signed in, rows          → the cards
//
// The account-specific states sit inside SignedOutGate: logout does not
// navigate, so without it a shared machine would keep showing the previous
// reader's list under a "log in" navbar.
//
// The first row is the large card (its banner, progress, "继续看第 N 集"); the
// next two are compact. Each card is ONE link to the detail page, which is
// where playback starts — the "button" inside is its label, not a second
// control. Progress reads `current/total` (e.g. "3/24 集"), the format the
// library-sync e2e spec asserts on.

import type { CSSProperties } from "react";
import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import LibraryExplainer from "@/components/home/LibraryExplainer";
import SectionHeader from "@/components/home/SectionHeader";
import { PlayIcon } from "@/components/home/icons";
import cards from "@/components/home/cards.module.css";
import section from "@/components/home/section.module.css";
import styles from "@/components/home/ContinueWatching.module.css";
import { formatRelativeTime } from "@/lib/formatters";
import type { Dict, Lang } from "@/lib/i18n";
import { fillTemplate } from "@/lib/home/time";
import { cardToneVars } from "@/lib/home/tone";
import type { ContinueCard } from "@/lib/home/viewModels";
import SignedOutGate from "./SignedOutGate";

const SHOWN = 3;

interface ContinueWatchingProps {
  items: ContinueCard[];
  loggedOut: boolean;
  dict: Dict;
  lang: Lang;
  nowMs: number;
  seasonHref: string;
}

function progressText(c: ContinueCard, dict: Dict): string {
  const unit = dict.detail.epUnit;
  return c.total ? `${c.current}/${c.total} ${unit}` : `${c.current} ${unit}`;
}

function progressLabel(c: ContinueCard, dict: Dict): string {
  return c.current > 0 ? fillTemplate(dict.home.continueProgress, { ep: c.current }) : dict.home.continueNotStarted;
}

function Bar({ c }: { c: ContinueCard }) {
  if (!c.total) return null;
  const pct = Math.min(100, (c.current / c.total) * 100);
  return (
    <span className={styles.track} aria-hidden>
      <span className={styles.fill} style={{ width: `${pct}%` }} />
    </span>
  );
}

function lastWatched(c: ContinueCard, dict: Dict, lang: Lang, nowMs: number): string | null {
  if (!c.lastWatchedAt) return null;
  const when = formatRelativeTime(c.lastWatchedAt, lang, nowMs);
  return when ? fillTemplate(dict.home.lastWatched, { when }) : null;
}

function Feature({ c, dict, lang, nowMs }: { c: ContinueCard; dict: Dict; lang: Lang; nowMs: number }) {
  const cta =
    c.current > 0 ? fillTemplate(dict.home.continueNext, { ep: c.nextEpisode }) : dict.home.continueStart;
  const seen = lastWatched(c, dict, lang, nowMs);
  return (
    <Link
      href={c.href}
      prefetch={false}
      className={`${cards.card} ${styles.feature}`}
      style={cardToneVars(c.hue) as unknown as CSSProperties}
    >
      <span className={styles.featureArt} aria-hidden>
        <FadeImage src={c.banner} alt="" width={1080} height={228} className={styles.featureImg} />
      </span>
      <span className={styles.featureShade} aria-hidden />
      <span className={styles.featureBody}>
        <span className={styles.kicker}>
          {c.statusLabel ? (
            <>
              <span className={styles.dot} data-live={c.live} aria-hidden />
              {c.statusLabel}
            </>
          ) : null}
          {c.statusLabel && seen ? " · " : ""}
          {seen}
        </span>
        <span className={`${cards.clamp1} ${styles.featureTitle}`}>{c.title}</span>
        <span className={styles.featureEp}>
          <span className={styles.featureEpStrong}>{progressLabel(c, dict)}</span>
          {c.seasonLine ? <span>{c.seasonLine}</span> : null}
        </span>
        <span className={styles.featureFoot}>
          <span className={styles.featureCta}>
            <PlayIcon />
            {cta}
          </span>
          <span className={styles.featureProgress}>
            <Bar c={c} />
            <span className={`${cards.mono} ${styles.progressText}`}>{progressText(c, dict)}</span>
          </span>
        </span>
      </span>
      <span className={cards.rule} aria-hidden />
    </Link>
  );
}

function Compact({ c, dict, lang, nowMs }: { c: ContinueCard; dict: Dict; lang: Lang; nowMs: number }) {
  const seen = lastWatched(c, dict, lang, nowMs);
  return (
    <Link
      href={c.href}
      prefetch={false}
      className={`${cards.card} ${styles.compact}`}
      style={cardToneVars(c.hue) as unknown as CSSProperties}
    >
      <span className={`${cards.cover} ${styles.compactCover}`}>
        <span className={cards.zoom}>
          <FadeImage src={c.cover} alt="" width={96} height={136} className={cards.img} />
        </span>
        <span className={cards.rule} aria-hidden />
      </span>
      <span className={styles.compactBody}>
        {c.statusLabel ? (
          <span className={styles.chip}>
            <span className={styles.dot} data-live={c.live} aria-hidden />
            {c.statusLabel}
          </span>
        ) : null}
        <span className={`${cards.title} ${cards.clamp2} ${styles.compactTitle}`}>{c.title}</span>
        {seen || c.seasonLine ? <span className={styles.compactLine}>{seen ?? c.seasonLine}</span> : null}
        <span className={styles.compactFoot}>
          <span className={styles.compactFootRow}>
            <span>{progressLabel(c, dict)}</span>
            <span className={cards.mono}>{progressText(c, dict)}</span>
          </span>
          <Bar c={c} />
        </span>
      </span>
      <span className={cards.rule} aria-hidden />
    </Link>
  );
}

export default function ContinueWatching({ items, loggedOut, dict, lang, nowMs, seasonHref }: ContinueWatchingProps) {
  const visitor = <LibraryExplainer dict={dict} variant="visitor" seasonHref={seasonHref} />;
  if (loggedOut) return visitor;
  if (items.length === 0) {
    return (
      <SignedOutGate signedOut={visitor}>
        <LibraryExplainer dict={dict} variant="empty" seasonHref={seasonHref} />
      </SignedOutGate>
    );
  }

  const [first, ...rest] = items.slice(0, SHOWN);
  return (
    <SignedOutGate signedOut={visitor}>
      <section className={`${section.section} ${styles.first}`} aria-labelledby="home-continue">
        <SectionHeader
          id="home-continue"
          title={dict.home.continueTitle}
          count={items.length}
          link={{ href: "/profile", label: dict.home.continueAll }}
        />
        <div className={styles.row} data-count={1 + rest.length}>
          <Feature c={first} dict={dict} lang={lang} nowMs={nowMs} />
          {rest.map((c) => (
            <Compact key={c.id} c={c} dict={dict} lang={lang} nowMs={nowMs} />
          ))}
        </div>
      </section>
    </SignedOutGate>
  );
}
