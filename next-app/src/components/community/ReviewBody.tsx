"use client";

// A review body (or a thread's opening post), rendered from the markup tree in
// lib/community/reviewMarkup.ts. Every piece of user text reaches the page as
// a React text node; there is no HTML string anywhere on this path.
//
// A spoiler is a button until it is pressed — its text is in the DOM, but
// transparent and unselectable, and announced as "剧透内容，点击显示" rather
// than read out.

import { useState, type ReactNode } from "react";
import { useLang } from "@/lib/lang-client";
import { parseReview, type Block, type Inline } from "@/lib/community/reviewMarkup";
import s from "./community.module.css";

function Spoiler({ children }: { children: ReactNode }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  if (open) return <span className={s.spoilerOpen}>{children}</span>;
  return (
    <button
      type="button"
      className={s.spoiler}
      onClick={() => setOpen(true)}
      aria-label={t("community.spoilerInline")}
      title={t("community.spoilerInline")}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.kind) {
      case "text":
        return <span key={key}>{node.text}</span>;
      case "break":
        return <br key={key} />;
      case "bold":
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case "spoiler":
        return <Spoiler key={key}>{renderInline(node.children, key)}</Spoiler>;
      case "link":
        return (
          <a key={key} href={node.href} target="_blank" rel="nofollow ugc noopener noreferrer">
            {node.text}
          </a>
        );
    }
  });
}

export function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, i) =>
    block.kind === "quote" ? (
      <blockquote key={i}>{renderInline(block.children, `q${i}`)}</blockquote>
    ) : (
      <p key={i}>{renderInline(block.children, `p${i}`)}</p>
    ),
  );
}

export default function ReviewBody({ source, className }: { source: string; className?: string }) {
  return <div className={className ? `${s.prose} ${className}` : s.prose}>{renderBlocks(parseReview(source))}</div>;
}
