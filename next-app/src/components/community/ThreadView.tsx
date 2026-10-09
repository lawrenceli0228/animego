"use client";

// A discussion thread on its own page: the opening post, the replies oldest
// first, and the composer at the bottom. 回复 on a reply answers that reply
// ("回复 @某人"), which notifies its author as well as the thread's.
//
// `initial` is the anonymous server render (ISR, cached for everyone). With a
// session the thread is read again after load, which marks the reader's own
// posts and drops anyone on either side of a block with them; a reply posted
// before that read answers is not undone by it (lib/community/freshRead.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link, { useLocaleRouter } from "@/components/ui/LocaleLink";
import { usePathname } from "next/navigation";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import { hasAuthHint } from "@/lib/clientAuth";
import { createThreadReply, deleteReply, deleteThread, errorKey, fetchThread } from "@/lib/community/api";
import { formatCommunityDate } from "@/lib/community/format";
import { freshRead } from "@/lib/community/freshRead";
import { notify } from "@/lib/community/notify";
import type { CommunityReply, CommunityThreadView } from "@/lib/community/types";
import { useViewer } from "@/lib/community/useViewer";
import Avatar from "./Avatar";
import ReportButton from "./ReportButton";
import { ConfirmDelete, ReplyComposer, ReplyList } from "./Replies";
import ReviewBody from "./ReviewBody";
import s from "./community.module.css";
import w from "./WriteReview.module.css";

interface ThreadViewProps {
  anilistId: number;
  animeTitle: string;
  initial: CommunityThreadView;
  renderedAt: string;
  lang: Lang;
}

export default function ThreadView({ anilistId, animeTitle, initial, renderedAt, lang }: ThreadViewProps) {
  const { t } = useLang();
  const router = useLocaleRouter();
  const pathname = usePathname();
  const { viewer, probing } = useViewer();
  const [view, setView] = useState(initial);
  const [spoilerOpen, setSpoilerOpen] = useState(!initial.thread.isSpoiler);
  const [busy, setBusy] = useState(false);
  const [busyReplyId, setBusyReplyId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<CommunityReply | null>(null);
  // Writes applied so far; see lib/community/freshRead.ts.
  const writes = useRef(0);
  const nowMs = useMemo(() => {
    const ms = Date.parse(renderedAt);
    return Number.isFinite(ms) ? ms : 0;
  }, [renderedAt]);
  const canAct = viewer !== null || probing;
  const thread = view.thread;
  const socialHref = `/anime/${anilistId}/social`;

  const reload = useCallback(async () => {
    const result = await freshRead(writes, () => fetchThread(anilistId, initial.thread.id));
    if (result?.ok) setView(result.data);
  }, [anilistId, initial.thread.id]);

  const applyWrite = (update: (current: CommunityThreadView) => CommunityThreadView) => {
    writes.current += 1;
    setView(update);
  };

  // The per-reader read. A notification lands on #reply-<id>; a reply newer
  // than the cached render only arrives with this read, after the browser's
  // own jump to the hash found nothing, so the jump is made again.
  useEffect(() => {
    if (!hasAuthHint()) return;
    const timer = window.setTimeout(() => {
      void reload().then(() => {
        const hash = window.location.hash;
        if (!hash.startsWith("#reply-")) return;
        window.requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: "center" }));
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const post = async (body: string, isSpoiler: boolean): Promise<boolean> => {
    setBusy(true);
    const result = await createThreadReply(anilistId, thread.id, { body, isSpoiler, parentId: replyTo?.id ?? null });
    setBusy(false);
    if (!result.ok) {
      notify("error", t(errorKey(result)));
      return false;
    }
    applyWrite((cur) => ({ ...cur, replies: [...cur.replies.filter((r) => r.id !== result.data.id), result.data] }));
    setReplyTo(null);
    window.requestAnimationFrame(() =>
      document.getElementById(`reply-${result.data.id}`)?.scrollIntoView({ block: "nearest" }),
    );
    return true;
  };

  const removeReply = async (reply: CommunityReply) => {
    setBusyReplyId(reply.id);
    const result = await deleteReply(anilistId, reply.id);
    setBusyReplyId(null);
    if (!result.ok) return notify("error", t(errorKey(result)));
    applyWrite((cur) => ({ ...cur, replies: cur.replies.filter((r) => r.id !== reply.id) }));
    notify("success", t("community.replyDeleted"));
  };

  const removeThread = async () => {
    setBusy(true);
    const result = await deleteThread(anilistId, thread.id);
    setBusy(false);
    if (!result.ok) return notify("error", t(errorKey(result)));
    notify("success", t("community.threadDeleted"));
    router.push(socialHref);
  };

  return (
    <div className={`${s.root} container ${w.page}`}>
      <nav className={w.crumbs} aria-label={t("community.crumbsLabel")}>
        <Link href={`/anime/${anilistId}`} prefetch={false}>
          {animeTitle}
        </Link>
        <span aria-hidden="true">›</span>
        <Link href={`${socialHref}#threads`} prefetch={false}>
          {t("detail.tabSocial")}
        </Link>
        <span aria-hidden="true">›</span>
        <span>{t("community.threads")}</span>
      </nav>

      <article className={`${s.card} ${w.threadCard}`} aria-labelledby="thread-title">
        <h1 className={w.threadTitle} id="thread-title">
          {thread.title}
        </h1>
        <div className={`${s.byline} ${w.threadByline}`}>
          <Avatar name={thread.author.username} avatarUrl={thread.author.avatarUrl} backdropCoverUrl={thread.author.backdropCoverUrl} />
          <div className={s.bylineText}>
            <Link href={`/u/${encodeURIComponent(thread.author.username)}`} prefetch={false} className={s.name}>
              {thread.author.username}
            </Link>
            <time className={s.meta} dateTime={thread.createdAt}>
              {formatCommunityDate(thread.createdAt, lang, nowMs)}
            </time>
          </div>
          {thread.isSpoiler ? <span className={s.chip}>{t("community.spoilerBadge")}</span> : null}
        </div>
        {spoilerOpen ? (
          <ReviewBody source={thread.body} className={s.reviewBody} />
        ) : (
          <button type="button" className={s.fold} onClick={() => setSpoilerOpen(true)}>
            {t("community.spoilerFolded")}
          </button>
        )}
        <div className={s.actions}>
          <span className={s.actionsEnd}>
            {thread.isOwn ? (
              <ConfirmDelete busy={busy} onConfirm={() => void removeThread()} />
            ) : (
              <ReportButton targetType="thread" targetId={thread.id} authenticated={canAct} />
            )}
          </span>
        </div>
      </article>

      <section className={`${s.section} ${w.threadReplies}`} aria-labelledby="thread-replies-heading">
        <header className={s.head}>
          <h2 className={s.headTitle} id="thread-replies-heading">
            {t("community.repliesHeading")}
          </h2>
          <span className={s.headCount}>{view.replies.length}</span>
        </header>
        {view.replies.length === 0 ? (
          <div className={s.empty}>
            <div className={s.emptyTitle}>{t("community.noReplies")}</div>
          </div>
        ) : (
          <div className={s.card}>
            <ReplyList
              replies={view.replies}
              lang={lang}
              nowMs={nowMs}
              signedIn={canAct}
              busyId={busyReplyId}
              onDelete={(reply) => void removeReply(reply)}
              onReplyTo={(reply) => setReplyTo(reply)}
            />
          </div>
        )}
        <div className={w.threadComposer}>
          {canAct ? (
            <ReplyComposer
              me={viewer ? { username: viewer.username, avatarUrl: viewer.avatarUrl, backdropCoverUrl: viewer.backdropCoverUrl } : null}
              label={t("community.reply")}
              busy={busy}
              allowSpoiler
              replyingTo={replyTo?.author.username ?? null}
              onCancelReplyTo={() => setReplyTo(null)}
              onSubmit={post}
            />
          ) : (
            <p className={s.loginLine}>
              <Link href={authHrefWithFrom("/login", pathname)} prefetch={false}>
                {t("community.login")}
              </Link>{" "}
              {t("community.loginToReply")}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
