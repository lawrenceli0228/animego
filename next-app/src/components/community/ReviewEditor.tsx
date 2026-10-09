"use client";

// The body of the write page (the canvas's WriteReview board, left column):
// the one-line summary, then the body with its toolbar — 加粗, 引用, 剧透块,
// 插入链接 — and the 编辑 / 预览 switch. Controlled: the page owns the text.
//
// The toolbar only ever inserts plain-text markers (lib/community/
// reviewMarkup.ts); the preview renders them exactly as the review will be.

import { useRef, useState } from "react";
import { useLang } from "@/lib/lang-client";
import { fillTemplate } from "@/lib/community/format";
import {
  BOLD,
  SPOILER_CLOSE,
  SPOILER_OPEN,
  linkSelection,
  quoteSelection,
  safeHref,
  wrapSelection,
  type Edit,
} from "@/lib/community/reviewMarkup";
import {
  REVIEW_BODY_MAX,
  REVIEW_BODY_MIN,
  REVIEW_SUMMARY_MAX,
  REVIEW_SUMMARY_MIN,
  normalizeLine,
  storedBodyLength,
  storedLineLength,
  visibleLength,
} from "@/lib/community/textLimits";
import { QuoteIcon } from "./Icons";
import ReviewBody from "./ReviewBody";
import s from "./community.module.css";
import w from "./WriteReview.module.css";

interface ReviewEditorProps {
  summary: string;
  body: string;
  onSummary: (value: string) => void;
  onBody: (value: string) => void;
  /** Show the out-of-range counters in red (after a first attempt to send). */
  showProblems: boolean;
}

export default function ReviewEditor({ summary, body, onSummary, onBody, showProblems }: ReviewEditorProps) {
  const { t } = useLang();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");

  const summaryVisible = visibleLength(normalizeLine(summary));
  const summaryStored = storedLineLength(summary);
  const summaryBad = summaryVisible < REVIEW_SUMMARY_MIN || summaryStored > REVIEW_SUMMARY_MAX;
  const bodyVisible = visibleLength(body);
  const bodyBad = bodyVisible < REVIEW_BODY_MIN || storedBodyLength(body) > REVIEW_BODY_MAX;

  const apply = (edit: (text: string, start: number, end: number) => Edit) => {
    const el = textarea.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = edit(body, start, end);
    onBody(next.text);
    // After React writes the new value, put the selection on the inserted text.
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  };

  const insertLink = () => {
    const safe = safeHref(href.trim());
    if (!safe) return;
    apply((text, start, end) => linkSelection(text, start, end, safe, t("community.linkTextPlaceholder")));
    setLinking(false);
    setHref("");
  };

  return (
    <section className={w.editorColumn}>
      <label className={s.label} htmlFor="review-summary">
        {t("community.summaryLabel")} <span className={w.req}>*</span>
      </label>
      <input
        id="review-summary"
        className={w.summaryInput}
        type="text"
        value={summary}
        onChange={(event) => onSummary(event.target.value)}
        placeholder={t("community.summaryPlaceholder")}
        maxLength={REVIEW_SUMMARY_MAX * 2}
        aria-invalid={showProblems && summaryBad ? true : undefined}
        aria-describedby="review-summary-count"
      />
      <div id="review-summary-count" className={showProblems && summaryBad ? s.counterOver : s.counter}>
        {fillTemplate(t("community.summaryCounter"), { n: summaryStored })}
      </div>

      <div className={w.bodyHead}>
        <label className={s.label} htmlFor="review-body">
          {t("community.bodyLabel")} <span className={w.req}>*</span>
        </label>
        <span className={s.spacer} />
        <div className={w.seg} role="group" aria-label={t("community.bodyLabel")}>
          <button type="button" className={mode === "edit" ? w.segOn : w.segBtn} aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>
            {t("community.modeEdit")}
          </button>
          <button
            type="button"
            className={mode === "preview" ? w.segOn : w.segBtn}
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            {t("community.modePreview")}
          </button>
        </div>
      </div>

      <div className={w.editor}>
        {mode === "edit" ? (
          <>
            <div className={w.toolbar}>
              <button
                type="button"
                className={w.toolIcon}
                aria-label={t("community.toolBold")}
                title={t("community.toolBold")}
                onClick={() => apply((text, a, b) => wrapSelection(text, a, b, BOLD, BOLD, t("community.boldPlaceholder")))}
              >
                <b>B</b>
              </button>
              <button
                type="button"
                className={w.toolIcon}
                aria-label={t("community.toolQuote")}
                title={t("community.toolQuote")}
                onClick={() => apply((text, a, b) => quoteSelection(text, a, b, t("community.quotePlaceholder")))}
              >
                <QuoteIcon />
              </button>
              <button
                type="button"
                className={w.tool}
                onClick={() =>
                  apply((text, a, b) => wrapSelection(text, a, b, SPOILER_OPEN, SPOILER_CLOSE, t("community.spoilerPlaceholder")))
                }
              >
                {t("community.toolSpoiler")}
              </button>
              <button type="button" className={w.tool} aria-expanded={linking} onClick={() => setLinking((v) => !v)}>
                {t("community.toolLink")}
              </button>
              {linking ? (
                <span className={w.linkRow}>
                  <input
                    className={w.linkInput}
                    type="url"
                    inputMode="url"
                    value={href}
                    onChange={(event) => setHref(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        insertLink();
                      }
                    }}
                    placeholder="https://"
                    aria-label={t("community.linkPrompt")}
                    autoFocus
                  />
                  <button type="button" className={w.tool} disabled={!safeHref(href.trim())} onClick={insertLink}>
                    {t("community.insert")}
                  </button>
                </span>
              ) : null}
            </div>
            <textarea
              ref={textarea}
              id="review-body"
              className={w.bodyInput}
              value={body}
              onChange={(event) => onBody(event.target.value)}
              placeholder={t("community.bodyPlaceholder")}
              aria-invalid={showProblems && bodyBad ? true : undefined}
              aria-describedby="review-body-count"
            />
          </>
        ) : (
          <div className={w.preview} aria-live="polite">
            {body.trim() ? (
              <ReviewBody source={body} className={s.reviewBody} />
            ) : (
              <p className={s.meta}>{t("community.previewEmpty")}</p>
            )}
          </div>
        )}
      </div>
      <div id="review-body-count" className={showProblems && bodyBad ? s.counterOver : s.counter}>
        {storedBodyLength(body) > REVIEW_BODY_MAX
          ? fillTemplate(t("community.bodyTooLong"), { n: storedBodyLength(body) })
          : fillTemplate(t("community.bodyCounter"), { n: bodyVisible })}
      </div>
    </section>
  );
}
