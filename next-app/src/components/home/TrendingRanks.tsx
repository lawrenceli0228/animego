// 大家都在追 — the most-tracked shows on the site, with large rank numerals in
// each show's own colour. Five to a row on a wide screen, a list of five on a
// phone. Server component: nothing here moves except CSS hover.

import type { CSSProperties } from "react";
import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import type { Dict } from "@/lib/i18n";
import { fillTemplate } from "@/lib/home/time";
import { cardToneVars } from "@/lib/home/tone";
import type { TrendCard } from "@/lib/home/viewModels";
import SectionHeader from "./SectionHeader";
import { ChevronIcon } from "./icons";
import cards from "./cards.module.css";
import section from "./section.module.css";
import styles from "./TrendingRanks.module.css";

export default function TrendingRanks({ items, dict }: { items: TrendCard[]; dict: Dict }) {
  if (items.length === 0) return null;
  return (
    <section className={section.section} aria-labelledby="home-trending">
      <SectionHeader id="home-trending" title={dict.home.trendingTitle} note={dict.home.trendingSub} />
      <ol className={styles.list}>
        {items.map((it) => (
          <li key={it.id} className={styles.item}>
            <Link
              href={it.href}
              prefetch={false}
              className={`${cards.card} ${styles.card}`}
              style={cardToneVars(it.hue) as unknown as CSSProperties}
            >
              <div className={styles.art}>
                <span className={`${cards.mono} ${styles.rank}`} aria-hidden>
                  {it.rank}
                </span>
                <div className={`${cards.cover} ${styles.cover}`}>
                  <span className={cards.zoom}>
                    <FadeImage src={it.cover} alt="" width={132} height={188} className={cards.img} />
                  </span>
                  <span className={cards.rule} aria-hidden />
                </div>
              </div>
              <div className={styles.body}>
                <span className={`${cards.title} ${cards.clamp1} ${styles.title}`}>
                  <span className={section.srOnly}>{fillTemplate(dict.home.rankSr, { n: it.rank })} </span>
                  {it.title}
                </span>
                <span className={styles.line}>
                  {fillTemplate(dict.home.watchersLine, { n: it.watchers })}
                  {it.scoreLine ? ` · ${it.scoreLine}` : ""}
                </span>
              </div>
              <ChevronIcon size={16} className={styles.chevron} />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
