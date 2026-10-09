"use client";

// 讨论帖: the thread list, and the composer 发帖 opens above it (the canvas's
// .compose card). A thread opens on its own page.

import { useState, type FormEvent } from "react";
import Link from "@/components/ui/LocaleLink";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import { fillTemplate, formatCommunityDate } from "@/lib/community/format";
import {
  THREAD_BODY_MAX,
  THREAD_TITLE_MAX,
  storedBodyLength,
  storedLineLength,
  threadProblems,
} from "@/lib/community/textLimits";
import type { CommunityPage, CommunityThreadSummary } from "@/lib/community/types";
import type { ThreadInput } from "@/lib/community/api";
import { PlusIcon } from "./Icons";
import s from "./community.module.css";

interface ThreadComposerProps {
  busy: boolean;
  onSubmit: (input: ThreadInput) => Promise<boolean>;
  onCancel: () => void;
}

export function ThreadComposer({ busy, onSubmit, onCancel }: ThreadComposerProps) {
  const { t } = useLang();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isSpoiler, setIsSpoiler] = useState(false);
  const problems = threadProblems(title, body);
  const titleLength = storedLineLength(title);
  const bodyLength = storedBodyLength(body);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problems.length > 0 || busy) return;
    if (await onSubmit({ title, body, isSpoiler })) {
      setTitle("");
      setBody("");
      setIsSpoiler(false);
    }
  };

  return (
    <form className={s.compose} onSubmit={submit} aria-label={t("community.newThread")}>
      <div className={s.field}>
        <label className={s.label} htmlFor="community-thread-title">
          {t("community.threadTitle")}
        </label>
        <input
          id="community-thread-title"
          className={s.input}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("community.threadTitlePlaceholder")}
          maxLength={THREAD_TITLE_MAX * 2}
          aria-invalid={problems.includes("titleLength") && title.length > 0 ? true : undefined}
          autoFocus
        />
        <div className={titleLength > THREAD_TITLE_MAX ? s.counterOver : s.counter}>
          {titleLength} / {THREAD_TITLE_MAX}
        </div>
      </div>
      <div className={s.field}>
        <label className={s.label} htmlFor="community-thread-body">
          {t("community.threadBody")}
        </label>
        <textarea
          id="community-thread-body"
          className={s.textarea}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={t("community.threadBodyPlaceholder")}
          rows={4}
        />
        {bodyLength > THREAD_BODY_MAX ? (
          <div className={s.counterOver}>
            {bodyLength} / {THREAD_BODY_MAX}
          </div>
        ) : null}
      </div>
      <div className={s.composeFoot}>
        <label className={s.check}>
          <input type="checkbox" checked={isSpoiler} onChange={(event) => setIsSpoiler(event.target.checked)} />
          {t("community.markSpoiler")}
        </label>
        <span className={s.spacer} />
        <button type="button" className={s.btnSm} onClick={onCancel}>
          {t("community.cancel")}
        </button>
        <button type="submit" className={s.btnSmSolid} disabled={busy || problems.length > 0}>
          {busy ? t("community.publishing") : t("community.publish")}
        </button>
      </div>
    </form>
  );
}

interface ThreadsSectionProps {
  anilistId: number;
  page: CommunityPage<CommunityThreadSummary>;
  lang: Lang;
  nowMs: number;
  canAct: boolean;
  loginHref: string;
  composing: boolean;
  busy: boolean;
  loadingMore: boolean;
  onCompose: (open: boolean) => void;
  onSubmit: (input: ThreadInput) => Promise<boolean>;
  onLoadMore: () => void;
}

export default function ThreadsSection({
  anilistId,
  page,
  lang,
  nowMs,
  canAct,
  loginHref,
  composing,
  busy,
  loadingMore,
  onCompose,
  onSubmit,
  onLoadMore,
}: ThreadsSectionProps) {
  const { t } = useLang();
  return (
    <section className={s.section} id="threads" aria-labelledby="community-threads-heading">
      <header className={s.head}>
        <h2 className={s.headTitle} id="community-threads-heading">
          {t("community.threads")}
        </h2>
        <span className={s.headCount}>{page.total}</span>
        {canAct ? (
          <button
            type="button"
            className={`${s.btnSm} ${s.headAction}`}
            aria-expanded={composing}
            onClick={() => onCompose(!composing)}
          >
            <PlusIcon />
            {t("community.newThread")}
          </button>
        ) : (
          <Link href={loginHref} prefetch={false} className={`${s.btnSm} ${s.headAction}`}>
            <PlusIcon />
            {t("community.newThread")}
          </Link>
        )}
      </header>
      {composing ? <ThreadComposer busy={busy} onSubmit={onSubmit} onCancel={() => onCompose(false)} /> : null}
      {page.items.length === 0 ? (
        composing ? null : (
          <div className={s.empty}>
            <div className={s.emptyTitle}>{t("community.noThreads")}</div>
          </div>
        )
      ) : (
        <ul className={s.threadList}>
          {page.items.map((thread) => (
            <li key={thread.id} className={s.threadRow}>
              <Link href={`/anime/${anilistId}/social/threads/${thread.id}`} prefetch={false} className={s.threadLink}>
                <div className={s.threadTitle}>
                  <span>{thread.title}</span>
                  {thread.isSpoiler ? <span className={s.chip}>{t("community.spoilerBadge")}</span> : null}
                </div>
                {thread.excerpt ? <div className={s.threadExcerpt}>{thread.excerpt}</div> : null}
                <div className={s.threadMeta}>
                  <span>{thread.author.username}</span>
                  <time dateTime={thread.lastActivityAt}>{formatCommunityDate(thread.lastActivityAt, lang, nowMs)}</time>
                  <span>{fillTemplate(t("community.replyCount"), { n: thread.replyCount })}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {page.hasMore ? (
        <button type="button" className={s.loadMore} onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? t("community.loading") : t("community.loadMore")}
        </button>
      ) : null}
    </section>
  );
}
