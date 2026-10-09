"use client";

// The write page (canvas: WriteReview): one form for a new review and for
// editing the reader's existing one — there is one review per reader per
// anime, so which of the two this is depends only on whether they already
// wrote it, and that is asked of the server after load.
//
//   signed out              → a login card instead of the form
//   no review yet           → empty form (or this browser's 存草稿 draft)
//   a review already        → the form filled with it; 保存修改 and 删除评价
//
// No score field. The summary is 10–60 characters, the body at least 300;
// the counters and the disabled 发布 say so, the server says it again.

import { useEffect, useState, type FormEvent } from "react";
import Link, { useLocaleRouter } from "@/components/ui/LocaleLink";
import { usePathname } from "next/navigation";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import FadeImage from "@/components/ui/FadeImage";
import { useLang } from "@/lib/lang-client";
import { createReview, deleteReview, errorKey, fetchMyReview, updateReview } from "@/lib/community/api";
import { clearDraft, loadDraft, saveDraft } from "@/lib/community/draft";
import { notify } from "@/lib/community/notify";
import { reviewProblems } from "@/lib/community/textLimits";
import { useViewer } from "@/lib/community/useViewer";
import ReviewEditor from "./ReviewEditor";
import s from "./community.module.css";
import w from "./WriteReview.module.css";

interface WriteReviewFormProps {
  anilistId: number;
  animeTitle: string;
  coverUrl: string | null;
}

type Phase = "checking" | "signedOut" | "ready";

export default function WriteReviewForm({ anilistId, animeTitle, coverUrl }: WriteReviewFormProps) {
  const { t } = useLang();
  const router = useLocaleRouter();
  const pathname = usePathname();
  const { viewer, settled } = useViewer();
  const [phase, setPhase] = useState<Phase>("checking");
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [isSpoiler, setIsSpoiler] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const socialHref = `/anime/${anilistId}/social`;
  const problems = reviewProblems(summary, body);

  // Signed out, or find the review to edit / the draft to resume.
  useEffect(() => {
    if (!settled) return;
    let cancelled = false;
    const run = async () => {
      if (!viewer) {
        setPhase("signedOut");
        return;
      }
      const mine = await fetchMyReview(anilistId);
      if (cancelled) return;
      if (mine.ok) {
        setReviewId(mine.data.id);
        setSummary(mine.data.summary);
        setBody(mine.data.body);
        setIsSpoiler(mine.data.isSpoiler);
        setIsPrivate(mine.data.isPrivate);
      } else {
        const draft = loadDraft(viewer.id, anilistId);
        if (draft) {
          setSummary(draft.summary);
          setBody(draft.body);
          setIsSpoiler(draft.isSpoiler);
          setIsPrivate(draft.isPrivate);
        }
      }
      setPhase("ready");
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [anilistId, settled, viewer]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problems.length > 0 || busy) return;
    setBusy(true);
    const input = { summary, body, isSpoiler, isPrivate };
    const result = reviewId ? await updateReview(anilistId, reviewId, input) : await createReview(anilistId, input);
    setBusy(false);
    if (!result.ok) {
      notify("error", t(errorKey(result)));
      return;
    }
    if (viewer) clearDraft(viewer.id, anilistId);
    notify("success", t(reviewId ? "community.reviewUpdated" : "community.reviewPublished"));
    router.push(`${socialHref}#review-${result.data.id}`);
  };

  const remove = async () => {
    if (!reviewId || busy) return;
    setBusy(true);
    const result = await deleteReview(anilistId, reviewId);
    setBusy(false);
    if (!result.ok) {
      notify("error", t(errorKey(result)));
      return;
    }
    notify("success", t("community.reviewDeleted"));
    router.push(socialHref);
  };

  const keepDraft = () => {
    if (viewer && saveDraft(viewer.id, anilistId, { summary, body, isSpoiler, isPrivate })) {
      notify("success", t("community.draftSaved"));
    } else {
      notify("error", t("community.errorFailed"));
    }
  };

  return (
    <div className={`${s.root} container ${w.page}`}>
      <nav className={w.crumbs} aria-label={t("community.crumbsLabel")}>
        <Link href={`/anime/${anilistId}`} prefetch={false}>
          {animeTitle}
        </Link>
        <span aria-hidden="true">›</span>
        <Link href={socialHref} prefetch={false}>
          {t("community.tabSocial")}
        </Link>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{reviewId ? t("community.editTitle") : t("community.writeTitle")}</span>
      </nav>
      <div className={w.pageHead}>
        <FadeImage src={coverUrl} alt="" width={52} height={74} className={w.pageCover} />
        <div>
          <h1 className={w.pageTitle}>{reviewId ? t("community.editTitle") : t("community.writeTitle")}</h1>
          <p className={w.pageSub}>{animeTitle}</p>
        </div>
      </div>

      {phase === "checking" ? (
        <p className={`${s.meta} ${w.state}`}>{t("community.loading")}</p>
      ) : phase === "signedOut" ? (
        <div className={`${s.empty} ${w.state}`}>
          <div className={s.emptyTitle}>{t("community.loginToWrite")}</div>
          <Link href={authHrefWithFrom("/login", pathname)} prefetch={false} className={`${s.btnSolid} ${w.loginBtn}`}>
            {t("community.login")}
          </Link>
        </div>
      ) : (
        <form className={w.grid} onSubmit={submit} noValidate>
          <ReviewEditor summary={summary} body={body} onSummary={setSummary} onBody={setBody} showProblems={tried} />
          <aside>
            <section className={s.card}>
              <h2 className={s.cardTitle}>{t("community.settings")}</h2>
              <div className={w.flags}>
                <label className={s.check}>
                  <input type="checkbox" checked={isSpoiler} onChange={(event) => setIsSpoiler(event.target.checked)} />
                  {t("community.flagSpoiler")}
                </label>
                <label className={s.check}>
                  <input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} />
                  {t("community.flagPrivate")}
                </label>
              </div>
              <div className={w.submitRow}>
                {/* Enabled while incomplete, on purpose: pressing it is what
                    marks the fields that are short (aria-invalid + the red
                    counters). A disabled button would say "no" without
                    saying why. It only looks quieter until the form is
                    complete. */}
                <button
                  type="submit"
                  className={`${s.btnSolid} ${w.grow}`}
                  disabled={busy}
                  data-incomplete={problems.length > 0 ? "true" : undefined}
                >
                  {busy ? t("community.publishing") : reviewId ? t("community.saveChanges") : t("community.publishReview")}
                </button>
                {reviewId ? null : (
                  <button type="button" className={s.btn} onClick={keepDraft}>
                    {t("community.saveDraft")}
                  </button>
                )}
              </div>
              {reviewId ? (
                <div className={w.deleteRow}>
                  {confirmDelete ? (
                    <span className={s.confirmPair}>
                      <button type="button" className={s.textBtnDanger} disabled={busy} onClick={() => void remove()}>
                        {t("community.deleteConfirm")}
                      </button>
                      <button type="button" className={s.textBtn} onClick={() => setConfirmDelete(false)}>
                        {t("community.cancel")}
                      </button>
                    </span>
                  ) : (
                    <button type="button" className={s.textBtn} onClick={() => setConfirmDelete(true)}>
                      {t("community.deleteReview")}
                    </button>
                  )}
                </div>
              ) : null}
            </section>
          </aside>
        </form>
      )}
    </div>
  );
}
