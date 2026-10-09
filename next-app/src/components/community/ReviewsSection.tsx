"use client";

// 评价: the reviews of this anime, most helpful first. No score anywhere —
// not on the card, not in the sort, not in the form.

import { useState } from "react";
import Link from "@/components/ui/LocaleLink";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import { formatCommunityDate } from "@/lib/community/format";
import type { CommunityPage, CommunityReview } from "@/lib/community/types";
import Avatar from "./Avatar";
import { PenIcon, ThumbIcon } from "./Icons";
import ReportButton from "./ReportButton";
import { ConfirmDelete } from "./Replies";
import ReviewBody from "./ReviewBody";
import s from "./community.module.css";

/** A review edited more than a minute after it was written says so. */
const EDITED_AFTER_MS = 60_000;

export function wasEdited(review: Pick<CommunityReview, "createdAt" | "updatedAt">): boolean {
  const created = Date.parse(review.createdAt);
  const updated = Date.parse(review.updatedAt);
  return Number.isFinite(created) && Number.isFinite(updated) && updated - created > EDITED_AFTER_MS;
}

interface ReviewCardProps {
  review: CommunityReview;
  lang: Lang;
  nowMs: number;
  /** Signed in, or still finding out (see useViewer). */
  canAct: boolean;
  loginHref: string;
  writeHref: string;
  busy: boolean;
  onToggleHelpful: (review: CommunityReview) => void;
  onOpenSpoiler: (review: CommunityReview) => void;
  onDelete: (review: CommunityReview) => void;
}

export function ReviewCard({
  review,
  lang,
  nowMs,
  canAct,
  loginHref,
  writeHref,
  busy,
  onToggleHelpful,
  onOpenSpoiler,
  onDelete,
}: ReviewCardProps) {
  const { t } = useLang();
  const [spoilerOpen, setSpoilerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const folded = review.isSpoiler && !spoilerOpen;
  const long = Array.from(review.body).length > 240 || review.body.split("\n").length > 6;

  const helpfulLabel = (
    <>
      <ThumbIcon filled={review.viewerVoted} />
      {t("community.helpful")}
      <span className={s.meta}>{review.helpfulCount}</span>
    </>
  );

  return (
    <article className={s.card} id={`review-${review.id}`} aria-labelledby={`review-${review.id}-summary`}>
      <div className={s.byline}>
        <Avatar name={review.author.username} avatarUrl={review.author.avatarUrl} backdropCoverUrl={review.author.backdropCoverUrl} />
        <div className={s.bylineText}>
          <Link href={`/u/${encodeURIComponent(review.author.username)}`} prefetch={false} className={s.name}>
            {review.author.username}
          </Link>
          <time className={s.meta} dateTime={review.createdAt}>
            {formatCommunityDate(review.createdAt, lang, nowMs)}
            {wasEdited(review) ? ` · ${t("community.edited")}` : ""}
          </time>
        </div>
        {review.isPrivate ? <span className={s.chipTone}>{t("community.privateBadge")}</span> : null}
        {review.isSpoiler ? <span className={s.chip}>{t("community.spoilerBadge")}</span> : null}
      </div>

      <h3 className={s.reviewSummary} id={`review-${review.id}-summary`}>
        {review.summary}
      </h3>

      {folded ? (
        <button
          type="button"
          className={s.fold}
          onClick={() => {
            setSpoilerOpen(true);
            if (review.bodyHidden) onOpenSpoiler(review);
          }}
        >
          {t("community.spoilerFolded")}
        </button>
      ) : review.bodyHidden ? (
        <p className={`${s.reviewBody} ${s.meta}`}>{t("community.loading")}</p>
      ) : (
        <>
          <ReviewBody source={review.body} className={`${s.reviewBody}${expanded || !long ? "" : ` ${s.clamped}`}`} />
          {long ? (
            <button type="button" className={s.textBtn} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
              {expanded ? t("community.collapse") : t("community.readMore")}
            </button>
          ) : null}
        </>
      )}

      <div className={s.actions}>
        {review.isOwn ? (
          <span className={s.chip}>
            <ThumbIcon />
            &nbsp;{t("community.helpful")}&nbsp;<span className={s.meta}>{review.helpfulCount}</span>
          </span>
        ) : canAct ? (
          <button
            type="button"
            className={s.btnGhost}
            aria-pressed={review.viewerVoted}
            disabled={busy}
            onClick={() => onToggleHelpful(review)}
          >
            {helpfulLabel}
          </button>
        ) : (
          <Link href={loginHref} prefetch={false} className={s.btnGhost}>
            {helpfulLabel}
          </Link>
        )}
        <span className={s.actionsEnd}>
          {review.isOwn ? (
            <>
              <Link href={writeHref} prefetch={false} className={s.textBtn}>
                {t("community.edit")}
              </Link>
              <ConfirmDelete busy={busy} onConfirm={() => onDelete(review)} />
            </>
          ) : (
            <ReportButton targetType="review" targetId={review.id} authenticated={canAct} />
          )}
        </span>
      </div>
    </article>
  );
}

interface ReviewsSectionProps {
  page: CommunityPage<CommunityReview>;
  lang: Lang;
  nowMs: number;
  canAct: boolean;
  loginHref: string;
  writeHref: string;
  /** The reader already wrote one: the button edits it instead. */
  hasOwnReview: boolean;
  busyId: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  onToggleHelpful: (review: CommunityReview) => void;
  onOpenSpoiler: (review: CommunityReview) => void;
  onDelete: (review: CommunityReview) => void;
}

export default function ReviewsSection({
  page,
  lang,
  nowMs,
  canAct,
  loginHref,
  writeHref,
  hasOwnReview,
  busyId,
  loadingMore,
  onLoadMore,
  onToggleHelpful,
  onOpenSpoiler,
  onDelete,
}: ReviewsSectionProps) {
  const { t } = useLang();
  return (
    <section className={s.section} id="reviews" aria-labelledby="community-reviews-heading">
      <header className={s.head}>
        <h2 className={s.headTitle} id="community-reviews-heading">
          {t("community.reviews")}
        </h2>
        <span className={s.headCount}>{page.total}</span>
        <Link href={writeHref} prefetch={false} className={`${s.btnSmSolid} ${s.headAction}`}>
          <PenIcon />
          {hasOwnReview ? t("community.editMyReview") : t("community.writeReview")}
        </Link>
      </header>
      {page.items.length === 0 ? (
        <div className={s.empty}>
          <div className={s.emptyTitle}>{t("community.noReviews")}</div>
        </div>
      ) : (
        <div className={s.list}>
          {page.items.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              lang={lang}
              nowMs={nowMs}
              canAct={canAct}
              loginHref={loginHref}
              writeHref={writeHref}
              busy={busyId === review.id}
              onToggleHelpful={onToggleHelpful}
              onOpenSpoiler={onOpenSpoiler}
              onDelete={onDelete}
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
