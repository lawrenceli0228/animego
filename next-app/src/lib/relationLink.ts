import { isPrintFormat, type PrintFormat } from "./contentLabels";

/** Where a relation card on /anime/[id] leads. */
export type RelationLink =
  | { kind: "anime"; href: string }
  | { kind: "print"; href: string; format: PrintFormat };

/**
 * The one place that decides where a relation card goes.
 *
 * An anime opens its own detail page here. A print work (manga, novel,
 * one-shot) has no page on this site, so it opens AniList's, which serves all
 * three under /manga/. A relation whose format is unknown is treated as an
 * anime, which is what nearly all of them turn out to be.
 *
 * When this site grows pages for print works, the print branch is the line to
 * change.
 */
export function relationLink(rel: { anilistId: number; format: string | null }): RelationLink {
  if (isPrintFormat(rel.format)) {
    return { kind: "print", href: `https://anilist.co/manga/${rel.anilistId}`, format: rel.format };
  }
  return { kind: "anime", href: `/anime/${rel.anilistId}` };
}
