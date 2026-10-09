"use client";

// A character's description: AniList's markup as React nodes
// (lib/people/anilistMarkdown.ts), with every ~!spoiler!~ collapsed behind a
// button until the reader asks for it. A spoiler spanning paragraphs is one
// spoiler: one button, where it starts, opens every piece.
//
// The text is AniList's or Bangumi's (lib/people/description.ts), in the same
// markup; the caller says which language it is in, and the block says so to
// assistive tech and to search engines with `lang` -- and, for Japanese, sets
// it in the Japanese face.

import { useMemo, useState, type ReactNode } from "react";
import { useLang } from "@/lib/lang-client";
import { parseAnilistMarkdown, type InlineNode } from "@/lib/people/anilistMarkdown";
import type { DescriptionLanguage } from "@/lib/people/description";
import s from "./people.module.css";

interface SpoilerDescriptionProps {
  markdown: string;
  lang: DescriptionLanguage;
}

export default function SpoilerDescription({ markdown, lang }: SpoilerDescriptionProps) {
  const { t } = useLang();
  const paragraphs = useMemo(() => parseAnilistMarkdown(markdown), [markdown]);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());

  const reveal = (id: number) => setRevealed((prev) => new Set(prev).add(id));

  const render = (nodes: InlineNode[], key: string): ReactNode[] =>
    nodes.map((n, i) => {
      const k = `${key}.${i}`;
      switch (n.type) {
        case "text":
          return n.value;
        case "br":
          return <br key={k} />;
        case "strong":
          return <strong key={k}>{render(n.children, k)}</strong>;
        case "em":
          return <em key={k}>{render(n.children, k)}</em>;
        case "spoiler":
          if (revealed.has(n.id)) {
            return (
              <span key={k} className={s.spoilerText}>
                {render(n.children, k)}
              </span>
            );
          }
          // Collapsed: the first piece is the button, the rest are nothing.
          return n.continued ? null : (
            <button
              key={k}
              type="button"
              className={s.spoilerButton}
              aria-expanded="false"
              aria-label={t("people.showSpoiler")}
              onClick={() => reveal(n.id)}
            >
              {t("people.spoiler")}
            </button>
          );
      }
    });

  const visible = paragraphs
    .map((p, i) => ({ key: `p${i}`, nodes: render(p.inlines, `p${i}`) }))
    .filter((p) => p.nodes.some((n) => n !== null && n !== ""));

  if (visible.length === 0) return null;
  return (
    <div className={lang === "ja" ? `${s.description} ${s.jp}` : s.description} lang={lang}>
      {visible.map((p) => (
        <p key={p.key}>{p.nodes}</p>
      ))}
    </div>
  );
}
