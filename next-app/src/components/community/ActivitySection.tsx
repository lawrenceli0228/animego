"use client";

// 最近动态: who started, finished, planned or dropped this anime, newest first —
// the canvas's cards, each with 回复 and 赞, the replies under it and the
// one-line composer 回复 opens.

import { useState } from "react";
import Link from "@/components/ui/LocaleLink";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import { ACTIVITY_KEY, fillTemplate, formatCommunityDate } from "@/lib/community/format";
import type { CommunityActivity, CommunityPage, CommunityReply } from "@/lib/community/types";
import Avatar from "./Avatar";
import { HeartIcon, ReplyIcon } from "./Icons";
import { ReplyComposer, ReplyList } from "./Replies";
import s from "./community.module.css";
import { anilistImgProps } from "@/lib/images/anilistImg";

export interface Me {
  username: string;
  avatarUrl: string | null;
  backdropCoverUrl?: string | null;
}

interface ActivityCardProps {
  item: CommunityActivity;
  animeTitle: string;
  coverUrl: string | null;
  lang: Lang;
  nowMs: number;
  canAct: boolean;
  me: Me | null;
  loginHref: string;
  highlighted: boolean;
  busy: boolean;
  busyReplyId: string | null;
  onToggleLike: (item: CommunityActivity) => void;
  onReply: (item: CommunityActivity, body: string) => Promise<boolean>;
  onDeleteReply: (item: CommunityActivity, reply: CommunityReply) => void;
  onShowAllReplies: (item: CommunityActivity) => void;
}

export function ActivityCard({
  item,
  animeTitle,
  coverUrl,
  lang,
  nowMs,
  canAct,
  me,
  loginHref,
  highlighted,
  busy,
  busyReplyId,
  onToggleLike,
  onReply,
  onDeleteReply,
  onShowAllReplies,
}: ActivityCardProps) {
  const { t } = useLang();
  const [replying, setReplying] = useState(false);
  const sentence = fillTemplate(t(ACTIVITY_KEY[item.status]), { title: animeTitle });
  const likeLabel = (
    <>
      <HeartIcon filled={item.viewerLiked} />
      {t("community.like")}
      {item.likeCount > 0 ? <span className={s.meta}>{item.likeCount}</span> : null}
    </>
  );

  return (
    <article
      className={`${s.cardTight} ${s.anchor}${highlighted ? ` ${s.highlight}` : ""}`}
      id={`activity-${item.id}`}
    >
      <div className={s.activityHead}>
        <Avatar name={item.author.username} avatarUrl={item.author.avatarUrl} backdropCoverUrl={item.author.backdropCoverUrl} />
        <div className={s.activityText}>
          <div className={s.activitySentence}>
            <Link href={`/u/${encodeURIComponent(item.author.username)}`} prefetch={false} className={s.name}>
              {item.author.username}
            </Link>{" "}
            {sentence}
          </div>
          <time className={s.meta} dateTime={item.createdAt}>
            {formatCommunityDate(item.createdAt, lang, nowMs)}
          </time>
        </div>
        {coverUrl ? (
          // The anime's own cover at 36px, already in the page above.
          // eslint-disable-next-line @next/next/no-img-element
          <img className={s.cover} {...anilistImgProps(coverUrl, 36, 50)} alt="" loading="lazy" />
        ) : null}
      </div>

      <div className={s.activityButtons}>
        <button
          type="button"
          className={s.btnGhost}
          aria-expanded={replying}
          onClick={() => setReplying((open) => !open)}
        >
          <ReplyIcon />
          {t("community.reply")}
          {item.replyCount > 0 ? <span className={s.meta}>{item.replyCount}</span> : null}
        </button>
        {canAct ? (
          <button
            type="button"
            className={s.btnGhost}
            aria-pressed={item.viewerLiked}
            disabled={busy}
            onClick={() => onToggleLike(item)}
          >
            {likeLabel}
          </button>
        ) : (
          <Link href={loginHref} prefetch={false} className={s.btnGhost}>
            {likeLabel}
          </Link>
        )}
      </div>

      <ReplyList
        replies={item.replies}
        lang={lang}
        nowMs={nowMs}
        signedIn={canAct}
        busyId={busyReplyId}
        onDelete={(reply) => onDeleteReply(item, reply)}
      />
      {item.replyCount > item.replies.length ? (
        <button type="button" className={s.textBtn} onClick={() => onShowAllReplies(item)}>
          {fillTemplate(t("community.showAllReplies"), { n: item.replyCount })}
        </button>
      ) : null}

      {replying ? (
        canAct ? (
          <ReplyComposer
            me={me}
            label={fillTemplate(t("community.replyTo"), { name: item.author.username })}
            busy={busy}
            autoFocus
            onSubmit={(body) => onReply(item, body)}
          />
        ) : (
          <p className={s.loginLine}>
            <Link href={loginHref} prefetch={false}>
              {t("community.login")}
            </Link>{" "}
            {t("community.loginToReply")}
          </p>
        )
      ) : null}
    </article>
  );
}

interface ActivitySectionProps extends Omit<ActivityCardProps, "item" | "highlighted" | "busy" | "busyReplyId"> {
  page: CommunityPage<CommunityActivity>;
  highlightId: string | null;
  busyId: string | null;
  busyReplyId: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export default function ActivitySection({
  page,
  highlightId,
  busyId,
  busyReplyId,
  loadingMore,
  onLoadMore,
  ...card
}: ActivitySectionProps) {
  const { t } = useLang();
  return (
    <section className={s.section} id="activity" aria-labelledby="community-activity-heading">
      <header className={s.head}>
        <h2 className={s.headTitle} id="community-activity-heading">
          {t("community.activity")}
        </h2>
        <span className={s.headCount}>{page.total}</span>
      </header>
      {page.items.length === 0 ? (
        <div className={s.empty}>
          <div className={s.emptyTitle}>{t("community.noActivity")}</div>
        </div>
      ) : (
        <div className={s.list}>
          {page.items.map((item) => (
            <ActivityCard
              key={item.id}
              item={item}
              highlighted={highlightId === item.id}
              busy={busyId === item.id}
              busyReplyId={busyReplyId}
              {...card}
            />
          ))}
        </div>
      )}
      {page.hasMore ? (
        <button type="button" className={s.loadMore} onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? t("community.loading") : t("community.loadMore")}
        </button>
      ) : null}
    </section>
  );
}
