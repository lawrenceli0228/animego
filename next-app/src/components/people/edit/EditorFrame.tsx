"use client";

// The frame of an edit state: the form, the phone's top bar (取消 · name ·
// 已改 N 处 · 提交) and the desktop bar that sits beside the name (已改 N 处 ·
// 取消 · 提交审核). Each editor puts the desktop bar into its header; CSS
// shows one bar per width, so a phone has exactly one submit control.
//
// Enter in a one-line field does not submit: the form is long, and the
// canvas's only ways to submit are the two buttons.

import type { CSSProperties, FormEvent, KeyboardEvent, ReactNode } from "react";
import Link from "@/components/ui/LocaleLink";
import { useLang } from "@/lib/lang-client";
import { fillTemplate } from "@/lib/people/template";
import p from "../people.module.css";
import e from "./edit.module.css";

interface BarProps {
  count: number;
  busy: boolean;
  cancelHref: string;
}

function ChangedTag({ count }: { count: number }) {
  const { t } = useLang();
  if (count <= 0) return null;
  return <span className={e.changedTag}>{fillTemplate(t("peopleEdit.changed"), { n: count })}</span>;
}

/** The desktop bar, for the editor's header. */
export function DesktopBar({ count, busy, cancelHref }: BarProps) {
  const { t } = useLang();
  return (
    <div className={e.bar}>
      <ChangedTag count={count} />
      <Link href={cancelHref} prefetch={false} className={e.btn}>
        {t("peopleEdit.cancel")}
      </Link>
      <button type="submit" className={`${e.btn} ${e.btnSolid}`} disabled={busy || count === 0}>
        {busy ? t("peopleEdit.submitting") : t("peopleEdit.submitReview")}
      </button>
    </div>
  );
}

interface EditorFrameProps extends BarProps {
  heading: string;
  hue?: CSSProperties;
  crumbs: ReactNode;
  error: string | null;
  onSubmit: () => void;
  children: ReactNode;
}

function keepEnterFromSubmitting(event: KeyboardEvent<HTMLFormElement>) {
  const target = event.target as HTMLElement;
  if (event.key === "Enter" && target instanceof HTMLInputElement && target.type !== "submit") {
    event.preventDefault();
  }
}

export default function EditorFrame({
  heading,
  hue,
  crumbs,
  error,
  onSubmit,
  count,
  busy,
  cancelHref,
  children,
}: EditorFrameProps) {
  const { t } = useLang();
  return (
    <form
      className={`container poster-scope ${p.page} ${e.editor}`}
      style={hue}
      noValidate
      onKeyDown={keepEnterFromSubmitting}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className={e.mobileBar}>
        <Link href={cancelHref} prefetch={false} className={`${e.btn} ${e.ghost}`}>
          {t("peopleEdit.cancel")}
        </Link>
        <span className={e.mobileBarTitle}>
          <span className={e.mobileBarName}>{heading}</span>
          <ChangedTag count={count} />
        </span>
        <button type="submit" className={`${e.btn} ${e.btnSolid}`} disabled={busy || count === 0}>
          {busy ? t("peopleEdit.submitting") : t("peopleEdit.submit")}
        </button>
      </div>
      <div className={e.crumbs}>{crumbs}</div>
      {children}
      <p className={e.formError} role="alert">
        {error ?? ""}
      </p>
    </form>
  );
}
