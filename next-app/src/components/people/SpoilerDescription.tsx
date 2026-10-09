"use client";

// A character's description: AniList's markup as React nodes
// (lib/people/anilistMarkdown.ts), with every ~!spoiler!~ collapsed behind a
// button until the reader asks for it. A spoiler spanning paragraphs is one
// spoiler: one button, where it starts, opens every piece.
//
// The description is AniList's, and AniList writes it in English; the
// paragraph says so to assistive tech and to search engines with `lang`.

import { useMemo, useState, type ReactNode } from "react";
import { useLang } from "@/lib/lang-client";
import { parseAnilistMarkdown, type InlineNode } from "@/lib/people/anilistMarkdown";
import s from "./people.module.css";

interface SpoilerDescriptionProps {
  markdown: string;
}

export default function SpoilerDescription({ markdown }: SpoilerDescriptionProps) {
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
    <div className={s.description} lang="en">
      {visible.map((p) => (
        <p key={p.key}>{p.nodes}</p>
      ))}
    </div>
  );
}
