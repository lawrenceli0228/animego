// 年度榜 — the year's top ten by AniList score, as a compact ranked list:
// rank, thumbnail, title, season, score. Hairlines between rows, no boxes
// (DESIGN.md's "拆框" rule: borders only on things that are themselves objects).

import type { CSSProperties } from "react";
import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { cardToneVars } from "@/lib/home/tone";
import type { YearCard } from "@/lib/home/viewModels";
import SectionHeader from "./SectionHeader";
import cards from "./cards.module.css";
import styles from "./YearTopList.module.css";

interface YearTopListProps {
  items: YearCard[];
  title: string;
  note: string;
  link: { href: string; label: string };
}

export default function YearTopList({ items, title, note, link }: YearTopListProps) {
  if (items.length === 0) return null;
  return (
    <section className={styles.section} aria-labelledby="home-year">
      <SectionHeader id="home-year" title={title} note={note} link={link} phoneHides={["note"]} />
      <ol className={styles.list}>
        {items.map((it) => (
          <li key={it.id} className={styles.item}>
            <Link
              href={it.href}
              prefetch={false}
              className={styles.row}
              style={cardToneVars(it.hue) as unknown as CSSProperties}
            >
              <span className={`${cards.mono} ${styles.rank}`}>{it.rank}</span>
              <FadeImage src={it.cover} alt="" width={30} height={42} className={styles.thumb} />
              <span className={`${cards.clamp1} ${styles.title}`}>{it.title}</span>
              {it.season ? <span className={styles.season}>{it.season}</span> : null}
              <span className={`${cards.mono} ${styles.score}`}>{it.score ?? ""}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
