import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { pickRelatedTitle, printFormatLabel, relationLabel } from "@/lib/contentLabels";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import { relationLink } from "@/lib/relationLink";
import type { DetailRelation } from "@/lib/types";
import x from "../sections.module.css";
import { POSTER_SRC_H, POSTER_SRC_W } from "./sectionImageSizes";

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

/** The arrow on a badge whose card opens another site, drawn in currentColor. */
function ExternalArrow() {
  return (
    <svg className={x.relBadgeArrow} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.5h5v5M9.5 2.5l-7 7" />
    </svg>
  );
}

/**
 * 关联作品: every relation AniList lists for the title, in RELATION_ORDER.
 *
 * Where a card leads is relationLink's decision. An anime card opens its page
 * here; a print work (manga, novel, one-shot) has no page here and opens
 * AniList in a new tab. Besides the relation in the top corner it carries a
 * second label in the bottom one naming what it is — 「漫画」 — with an arrow,
 * because a print work's title is usually the same romaji as the anime it
 * belongs to and the cover alone does not say which one the card is. Two
 * one-word labels rather than one 「改编 · 漫画」, which in English is wider
 * than the narrowest card.
 */
export default function RelationsSection({
  relations,
  lang,
  dict,
}: {
  relations: DetailRelation[];
  lang: Lang;
  dict: Dict;
}) {
  if (!relations.length) return null;
  const sorted = [...relations].sort((a, b) => {
    const ai = RELATION_ORDER.indexOf(a.relationType);
    const bi = RELATION_ORDER.indexOf(b.relationType);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <section className={x.section}>
      <header className={x.head}>
        <h2 className={x.headTitle}>{dict.detail.relations}</h2>
        <span className={x.headCount}>{sorted.length}</span>
      </header>
      <div className={x.posterGrid}>
        {sorted.map((rel) => {
          const label = relationLabel(rel.relationType, lang);
          // Cards mirror the inline hero chips — same helper, same
          // server-pinned zh, so likewise Chinese-first for everyone. Both
          // sites previously hardcoded romaji-wins and suppressed titleChinese
          // outright. Wire field is `title` not `titleRomaji`.
          const relTitle = pickRelatedTitle(rel, lang);
          const link = relationLink(rel);
          const key = `${rel.anilistId}-${rel.relationType}`;
          // .card-lift is the global reduced-motion-guarded hover lift
          // (globals.css); the module adds the glow and the image scale,
          // which it cannot express, and deliberately does not add a
          // second transform on top of it.
          const className = `card-lift ${x.posterCard}`;
          const body = (
            <>
              <div className={x.posterFrame}>
                {rel.coverImageUrl ? (
                  <FadeImage
                    src={rel.coverImageUrl}
                    alt={relTitle}
                    width={POSTER_SRC_W}
                    height={POSTER_SRC_H}
                    className={x.posterImg}
                  />
                ) : (
                  <span className={x.posterEmpty}>N/A</span>
                )}
                <span className={x.relBadge}>{label}</span>
                {link.kind === "print" && (
                  <span className={x.relFormat}>
                    {printFormatLabel(link.format, lang)}
                    <ExternalArrow />
                  </span>
                )}
              </div>
              <p className={x.posterTitle}>{relTitle}</p>
            </>
          );

          return link.kind === "print" ? (
            <a
              key={key}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              title={dict.detail.viewOnAnilist}
              className={className}
            >
              {body}
            </a>
          ) : (
            <Link key={key} href={link.href} prefetch={false} className={className}>
              {body}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
