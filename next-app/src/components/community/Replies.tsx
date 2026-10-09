"use client";

// Replies — under an activity card on the tab, and under a thread on its page
// — and the one-line composer the canvas draws for them (my initial, an
// input that says 最多 500 字, 发送).

import { useState, type FormEvent } from "react";
import Link from "@/components/ui/LocaleLink";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import { formatCommunityDate, fillTemplate } from "@/lib/community/format";
import { REPLY_MAX, replyProblem, storedBodyLength } from "@/lib/community/textLimits";
import type { CommunityReply } from "@/lib/community/types";
import Avatar from "./Avatar";
import ReportButton from "./ReportButton";
import s from "./community.module.css";
import rp from "./Replies.module.css";

/** Delete with one confirmation step, in place — no dialog. */
export function ConfirmDelete({ onConfirm, busy }: { onConfirm: () => void; busy: boolean }) {
  const { t } = useLang();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={s.textBtn} onClick={() => setAsking(true)}>
        {t("community.delete")}
      </button>
    );
  }
  return (
    <span className={s.confirmPair}>
      <button
        type="button"
        className={s.textBtnDanger}
        disabled={busy}
        onClick={() => {
          onConfirm();
          setAsking(false);
        }}
      >
        {t("community.deleteConfirm")}
      </button>
      <button type="button" className={s.textBtn} onClick={() => setAsking(false)}>
        {t("community.cancel")}
      </button>
    </span>
  );
}

interface ReplyListProps {
  replies: CommunityReply[];
  lang: Lang;
  nowMs: number;
  signedIn: boolean;
  busyId: string | null;
  onDelete: (reply: CommunityReply) => void;
  /** Thread pages offer 回复 on each reply; activity cards do not. */
  onReplyTo?: (reply: CommunityReply) => void;
  /** Element ids, so a notification can land on one reply. */
  idPrefix?: string;
}

export function ReplyList({ replies, lang, nowMs, signedIn, busyId, onDelete, onReplyTo, idPrefix = "reply-" }: ReplyListProps) {
  const { t } = useLang();
  if (replies.length === 0) return null;
  return (
    <ul className={rp.replies}>
      {replies.map((reply) => (
        <li key={reply.id} id={`${idPrefix}${reply.id}`} className={`${rp.reply} ${s.anchor}`}>
          <Avatar name={reply.author.username} avatarUrl={reply.author.avatarUrl} backdropCoverUrl={reply.author.backdropCoverUrl} small />
          <div className={rp.replyMain}>
            <div className={rp.replyHead}>
              <Link href={`/u/${encodeURIComponent(reply.author.username)}`} prefetch={false} className={s.name}>
                {reply.author.username}
              </Link>
              {reply.replyToUsername ? (
                <span className={rp.replyTo}>{fillTemplate(t("community.replyTo"), { name: reply.replyToUsername })}</span>
              ) : null}
              <time className={s.meta} dateTime={reply.createdAt}>
                {formatCommunityDate(reply.createdAt, lang, nowMs)}
              </time>
            </div>
            <SpoilerText text={reply.body} isSpoiler={reply.isSpoiler} />
            <div className={rp.replyActions}>
              {onReplyTo && signedIn && !reply.isOwn ? (
                <button type="button" className={s.textBtn} onClick={() => onReplyTo(reply)}>
                  {t("community.reply")}
                </button>
              ) : null}
              {reply.isOwn ? (
                <ConfirmDelete busy={busyId === reply.id} onConfirm={() => onDelete(reply)} />
              ) : (
                <ReportButton targetType="reply" targetId={reply.id} authenticated={signedIn} />
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A reply's text; a spoiler reply stays folded until asked. */
function SpoilerText({ text, isSpoiler }: { text: string; isSpoiler: boolean }) {
  const { t } = useLang();
  const [open, setOpen] = useState(!isSpoiler);
  if (!open) {
    return (
      <button type="button" className={s.fold} onClick={() => setOpen(true)}>
        {t("community.spoilerFolded")}
      </button>
    );
  }
  return <p className={rp.replyBody}>{text}</p>;
}

interface ReplyComposerProps {
  me: { username: string; avatarUrl: string | null; backdropCoverUrl?: string | null } | null;
  label: string;
  busy: boolean;
  /** Resolves true when the reply was posted (the field then clears). */
  onSubmit: (body: string, isSpoiler: boolean) => Promise<boolean>;
  /** Thread replies may be marked as spoilers; activity replies are one line. */
  allowSpoiler?: boolean;
  replyingTo?: string | null;
  onCancelReplyTo?: () => void;
  autoFocus?: boolean;
}

export function ReplyComposer({
  me,
  label,
  busy,
  onSubmit,
  allowSpoiler = false,
  replyingTo,
  onCancelReplyTo,
  autoFocus,
}: ReplyComposerProps) {
  const { t } = useLang();
  const [text, setText] = useState("");
  const [spoiler, setSpoiler] = useState(false);
  const problem = replyProblem(text);
  const over = storedBodyLength(text) > REPLY_MAX;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || busy) return;
    if (await onSubmit(text, spoiler)) {
      setText("");
      setSpoiler(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {replyingTo ? (
        <div className={s.loginLine}>
          {fillTemplate(t("community.replyTo"), { name: replyingTo })}{" "}
          <button type="button" className={s.textBtn} onClick={onCancelReplyTo}>
            {t("community.cancel")}
          </button>
        </div>
      ) : null}
      <div className={rp.composer}>
        <Avatar name={me?.username || t("community.you")} avatarUrl={me?.avatarUrl} backdropCoverUrl={me?.backdropCoverUrl} small />
        <input
          className={rp.composerInput}
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("community.replyPlaceholder")}
          aria-label={label}
          aria-invalid={over || undefined}
          maxLength={REPLY_MAX * 2}
          autoFocus={autoFocus}
        />
        <button type="submit" className={s.btnSmSolid} disabled={busy || problem !== null}>
          {busy ? t("community.sending") : t("community.send")}
        </button>
      </div>
      {allowSpoiler || over ? (
        <div className={s.composeFoot}>
          {allowSpoiler ? (
            <label className={s.check}>
              <input type="checkbox" checked={spoiler} onChange={(event) => setSpoiler(event.target.checked)} />
              {t("community.markSpoiler")}
            </label>
          ) : null}
          <span className={s.spacer} />
          {over ? (
            <span className={s.counterOver}>
              {storedBodyLength(text)} / {REPLY_MAX}
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
