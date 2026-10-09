"use client";

// One submission under review (the canvas's ReviewQueue card): who sent it
// and on what source, then each change with its value before and after --
// the photos side by side -- and a checkbox per change. Unchecking one asks
// for the reason the submitter will read. 「采纳勾选的 N 处」 sends what is
// checked, 「全部采纳」 accepts everything, 「不采纳」 unchecks everything so each
// change can be given its reason.
//
// A reviewed submission is shown the same way, read-only, with each change's
// outcome and note.

import { useRouter } from "next/navigation";
import { useState } from "react";
import toast from "react-hot-toast";
import Link from "@/components/ui/LocaleLink";
import { pickTitle } from "@/lib/formatters";
import { useLang } from "@/lib/lang-client";
import { characterDisplayName, personDisplayName } from "@/lib/people/names";
import { characterPath, personPath } from "@/lib/people/paths";
import {
  decisionsComplete,
  fieldLabelKey,
  initialDecisions,
  reviewBody,
  type Decision,
  type EditItem,
  type EditSubmission,
} from "@/lib/people/edit/review";
import { fillTemplate } from "@/lib/people/template";
import { reviewEditSubmission } from "../../_actions/edits";
import EditValue from "./EditValue";
import q from "../edits.module.css";

/** "role" rows say which title; the rest are named by their field. */
function FieldName({ item }: { item: EditItem }) {
  const { lang, t } = useLang();
  const work = item.meta?.work;
  return (
    <>
      <span className={q.fieldTitle}>{t(fieldLabelKey(item.field))}</span>
      {item.field === "role" && work ? (
        <span className={q.fieldSub}>{pickTitle(work, lang) || work.titleRomaji}</span>
      ) : null}
    </>
  );
}

export default function ReviewPanel({ submission }: { submission: EditSubmission }) {
  const { lang, t } = useLang();
  const router = useRouter();
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => initialDecisions(submission.items));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = submission.status === "pending";
  const name =
    submission.kind === "person"
      ? personDisplayName(submission.snapshot.name, lang)
      : characterDisplayName(submission.snapshot.name, lang);
  const work = submission.snapshot.work;
  const title = [name || `#${submission.entityId}`, work ? pickTitle(work, lang) || work.titleRomaji : null]
    .filter(Boolean)
    .join(" · ");
  const pageHref = submission.kind === "person" ? personPath(submission.entityId) : characterPath(submission.entityId);
  const history =
    submission.submitter.accepted > 0
      ? fillTemplate(t("editReview.acceptedBefore"), { n: submission.submitter.accepted })
      : fillTemplate(t("editReview.nth"), { n: submission.submitter.nth });
  const checked = submission.items.filter((it) => decisions[it.id]?.accept).length;
  const complete = decisionsComplete(submission.items, decisions);
  const labels = { oldImage: t("editReview.oldImage"), newImage: t("editReview.newImage") };

  const setDecision = (id: string, next: Partial<Decision>) =>
    setDecisions((all) => ({ ...all, [id]: { ...(all[id] ?? { accept: true, note: "" }), ...next } }));

  const send = async (all: Record<string, Decision>) => {
    if (!decisionsComplete(submission.items, all)) {
      setError(t("editReview.noteRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await reviewEditSubmission(submission.id, reviewBody(submission.items, all));
    setBusy(false);
    if (result.ok) {
      toast.success(t("editReview.statusReviewed"));
      router.refresh();
      return;
    }
    // The repo compiles without strict null checks, which leaves this union
    // un-narrowed; the failure arm is the only one with a status.
    const status = "status" in result ? result.status : 0;
    setError(status === 409 ? t("editReview.conflict") : t("editReview.failed"));
  };

  const acceptAll = () => {
    const all = Object.fromEntries(submission.items.map((it) => [it.id, { accept: true, note: "" }]));
    setDecisions(all);
    void send(all);
  };

  const uncheckAll = () =>
    setDecisions((all) =>
      Object.fromEntries(submission.items.map((it) => [it.id, { accept: false, note: all[it.id]?.note ?? "" }])),
    );

  return (
    <div className={q.card}>
      <div className={q.cardHead}>
        {submission.snapshot.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={submission.snapshot.image} alt="" className={q.thumb} />
        ) : null}
        <div className={q.spacer}>
          <h2 className={q.cardTitle}>{title}</h2>
          <div className={q.cardSub}>
            {fillTemplate(t("editReview.submittedBy"), { user: submission.submitter.username })} · {history} ·{" "}
            <Link href={pageHref} prefetch={false}>
              {t("editReview.openPage")}
            </Link>
            {submission.reviewer
              ? ` · ${fillTemplate(t("editReview.reviewedBy"), { user: submission.reviewer })}`
              : null}
          </div>
        </div>
        <span className={pending ? `${q.state} ${q.stateTone}` : q.state}>
          {pending ? t("editReview.statusPending") : t("editReview.statusReviewed")}
        </span>
      </div>

      <div className={q.meta}>
        <div>
          <span className={q.label}>{t("editReview.source")}</span>
          <div className={q.metaValue}>
            <a href={submission.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
              {submission.sourceUrl}
            </a>
          </div>
        </div>
        <div>
          <span className={q.label}>{t("editReview.note")}</span>
          <div className={q.metaValue}>{submission.note ?? "—"}</div>
        </div>
      </div>

      <div className={q.diff} role="table" aria-label={t("editReview.diffLabel")}>
        <div className={`${q.row} ${q.headRow}`} role="row">
          <span role="columnheader">{t("editReview.colField")}</span>
          <span role="columnheader">{t("editReview.colOld")}</span>
          <span role="columnheader">{t("editReview.colNew")}</span>
        </div>
        {submission.items.map((item) => {
          const d = decisions[item.id] ?? { accept: true, note: "" };
          return (
            <div key={item.id} className={q.row} role="row">
              <span role="cell">
                {pending ? (
                  <label className={q.check}>
                    <input
                      type="checkbox"
                      checked={d.accept}
                      onChange={(event) => setDecision(item.id, { accept: event.target.checked })}
                    />
                    <span>
                      <FieldName item={item} />
                    </span>
                  </label>
                ) : (
                  <span>
                    <FieldName item={item} />
                    <span className={item.status === "accepted" ? `${q.fieldSub} ${q.new}` : q.fieldSub}>
                      {item.status === "accepted" ? t("editReview.accepted") : t("editReview.rejected")}
                    </span>
                  </span>
                )}
              </span>
              <span role="cell">
                <EditValue item={item} side="old" lang={lang} labels={labels} />
              </span>
              <span role="cell">
                <EditValue item={item} side="new" lang={lang} labels={labels} />
              </span>
              {pending && !d.accept ? (
                <span className={q.noteRow} role="cell">
                  <textarea
                    className={q.textArea}
                    aria-label={`${t("editReview.rejectNote")} · ${t(fieldLabelKey(item.field))}`}
                    placeholder={t("editReview.rejectPlaceholder")}
                    maxLength={500}
                    value={d.note}
                    onChange={(event) => setDecision(item.id, { note: event.target.value })}
                  />
                </span>
              ) : null}
              {!pending && item.rejectNote ? (
                <span className={`${q.noteRow} ${q.rejectNote}`} role="cell">
                  {item.rejectNote}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {pending ? (
        <div className={q.actions}>
          <button
            type="button"
            className={`${q.btn} ${q.btnSolid}`}
            disabled={busy || !complete}
            onClick={() => void send(decisions)}
          >
            {checked > 0 ? fillTemplate(t("editReview.acceptChecked"), { n: checked }) : t("editReview.rejectRest")}
          </button>
          <button type="button" className={q.btn} disabled={busy} onClick={acceptAll}>
            {t("editReview.acceptAll")}
          </button>
          <button type="button" className={q.btn} disabled={busy} onClick={uncheckAll}>
            {t("editReview.rejectAll")}
          </button>
        </div>
      ) : null}
      <p className={q.error} role="alert">
        {error ?? ""}
      </p>
    </div>
  );
}
