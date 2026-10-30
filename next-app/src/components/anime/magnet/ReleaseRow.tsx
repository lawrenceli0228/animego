"use client";

// One release: group, episode and date; the full title; its tags, size and
// source; copy and open. Memoised — a copy confirmation re-renders one row,
// not the forty around it.

import { memo, useId } from "react";
import type { MagnetRow } from "@/lib/magnet/list";
import { CheckIcon, CopyIcon, OpenIcon } from "./icons";
import s from "./MagnetPanel.module.css";

export interface ReleaseRowText {
  unnamed: string;
  copy: string;
  copied: string;
  copyFailed: string;
  open: string;
}

/** Where the row's copy button stands: as drawn, just copied, or refused by the browser. */
export type CopyState = "idle" | "done" | "failed";

interface ReleaseRowProps {
  row: MagnetRow;
  /** Position in the rendered list; marks the row for the batch loader. */
  index: number;
  /** Position within its batch, for the entrance stagger. */
  stagger: number;
  /** "第 10 集" / "合集", or null for no tag. */
  episodeText: string | null;
  /** The tag is a word (合集), not a number: set in the text face, not mono. */
  episodeIsWord: boolean;
  /** "简繁内封", or null. */
  subTag: string | null;
  sourceName: string;
  copy: CopyState;
  text: ReleaseRowText;
  onCopy: (row: MagnetRow) => void;
  onOpen: (row: MagnetRow) => void;
}

function ReleaseRow({
  row,
  index,
  stagger,
  episodeText,
  episodeIsWord,
  subTag,
  sourceName,
  copy,
  text,
  onCopy,
  onOpen,
}: ReleaseRowProps) {
  const { resolution, codec, source } = row.facts;
  const meta = [row.size, sourceName].filter(Boolean).join(" · ");
  // The buttons are described by the title, so a list of buttons read out of
  // context still says which release each one is for.
  const titleId = useId();
  const copyLabel = copy === "done" ? text.copied : copy === "failed" ? text.copyFailed : text.copy;
  return (
    <div className={s.row} data-row={index} style={{ animationDelay: `${stagger}ms` }}>
      <div className={s.rtop}>
        <span className={row.fansub ? s.fs : `${s.fs} ${s.fsNone}`}>{row.fansub || text.unnamed}</span>
        {episodeText ? (
          <span className={episodeIsWord ? `${s.epb} ${s.epbWord}` : s.epb}>{episodeText}</span>
        ) : null}
        {row.date ? <span className={s.date}>{row.date}</span> : null}
      </div>
      <p id={titleId} className={s.title}>
        {row.title}
      </p>
      <div className={s.rbot}>
        <div className={s.tags}>
          {resolution ? <span className={`${s.tag} ${s.tagRes}`}>{resolution}</span> : null}
          {subTag ? <span className={`${s.tag} ${s.tagSub}`}>{subTag}</span> : null}
          {codec ? <span className={s.tag}>{codec}</span> : null}
          {source ? <span className={s.tag}>{source}</span> : null}
          {meta ? <span className={s.meta}>{meta}</span> : null}
        </div>
        <div className={s.acts}>
          <button
            type="button"
            className={s.copy}
            data-state={copy}
            aria-describedby={titleId}
            onClick={() => onCopy(row)}
          >
            {copy === "done" ? <CheckIcon /> : <CopyIcon />}
            {copyLabel}
          </button>
          <button
            type="button"
            className={s.open}
            aria-label={text.open}
            aria-describedby={titleId}
            title={text.open}
            onClick={() => onOpen(row)}
          >
            <OpenIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(ReleaseRow);
