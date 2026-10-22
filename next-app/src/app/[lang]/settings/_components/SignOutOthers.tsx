"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useLang } from "@/lib/lang-client";
import { fillTemplate } from "@/lib/home/time";

interface SignOutOthersProps {
  /** How many other sessions the confirm is about. */
  count: number;
  /** Ends them; resolves true when it worked (the caller reports either way). */
  onConfirm: () => Promise<boolean>;
}

/**
 * 退出其他设备 and its confirm: a small non-modal dialog anchored under the
 * button. It opens with focus on 取消, the safe answer; Escape or 取消 close it
 * and hand focus back to the button, and a press outside it (or Tab out of
 * it) closes it where the reader went.
 */
export default function SignOutOthers({ count, onConfirm }: SignOutOthersProps) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const working = useRef(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const titleId = useId();
  const bodyId = useId();

  const dismiss = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, dismiss]);

  const confirm = async () => {
    if (working.current) return;
    working.current = true;
    const ended = await onConfirm();
    working.current = false;
    // On failure the dialog stays, so the reader can try again or cancel.
    if (ended) setOpen(false);
  };

  const title =
    count === 1
      ? t("settings.signOutOthersTitleOne")
      : fillTemplate(t("settings.signOutOthersTitle"), { n: count });

  return (
    <div
      className="set-pop-anchor"
      ref={anchorRef}
      onBlur={(event) => {
        // Focus left the button and the dialog both: Tab moved on.
        const next = event.relatedTarget as Node | null;
        if (open && next && !anchorRef.current?.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="set-btn danger sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        {t("settings.signOutOthers")}
      </button>
      {open && (
        <div
          id={dialogId}
          className="set-pop"
          role="dialog"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
        >
          <p className="set-pop-title" id={titleId}>
            {title}
          </p>
          <p className="set-pop-text" id={bodyId}>
            {t("settings.signOutOthersBody")}
          </p>
          <div className="set-pop-actions">
            <button ref={cancelRef} type="button" className="set-btn quiet sm" onClick={dismiss}>
              {t("settings.cancel")}
            </button>
            <button type="button" className="set-btn danger sm" onClick={() => void confirm()}>
              {t("settings.signOutAll")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
