"use client";

// The question asked before the seasonal page's ✓ takes history with it. The
// server kept the row (DELETE /:id/untouched answered 409): it holds progress,
// a score, another status or a conversation on its status card, and the plain
// DELETE removes all of it — the episode marks and the cards cascade.
//
// A modal and not a toast, because it is the one place on the page where the
// wrong button loses something: focus moves in, lands on the safe answer, and
// stays between the two buttons until one is pressed (or Escape, or a click
// outside, which both keep). The dialog itself takes focus (tabIndex -1), so a
// click on its text keeps the keyboard inside instead of dropping it on <body>,
// where Escape would reach nothing and Shift+Tab the page behind. Its
// description reads the show and what goes, not just the warning.
//
// Portalled to <body>: a card is a stacking context (its entrance animation,
// the hover z-index), and a fixed overlay inside one is painted under the
// cards that follow it.

import { useEffect, useId, useRef, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { unfollowFacts } from "@/components/anime/quickSubscribeState";
import { useLang } from "@/lib/lang-client";
import { useScrollLock } from "@/lib/scrollLock";
import type { SubscriptionDoc } from "@/lib/subscriptionBus";
import styles from "./dialog.module.css";

interface UnfollowDialogProps {
  title: string;
  /** What the row holds, read after the server kept it; null if the read failed. */
  doc: SubscriptionDoc | null;
  onKeep: () => void;
  onConfirm: () => void;
  /** The ✓ that opened it: focus goes back there on close. */
  returnFocusTo: RefObject<HTMLElement | null>;
}

export default function UnfollowDialog({ title, doc, onKeep, onConfirm, returnFocusTo }: UnfollowDialogProps) {
  const { t } = useLang();
  const titleId = useId();
  const showId = useId();
  const factsId = useId();
  const bodyId = useId();
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useScrollLock(true);

  useEffect(() => {
    keepRef.current?.focus();
    const trigger = returnFocusTo.current;
    return () => trigger?.focus({ preventScroll: true });
  }, [returnFocusTo]);

  const facts = unfollowFacts(doc, {
    episode: t("card.unfollowFactEpisode"),
    score: t("card.unfollowFactScore"),
    statuses: {
      watching: t("sub.watching"),
      completed: t("sub.completed"),
      plan_to_watch: t("sub.planToWatch"),
      dropped: t("sub.dropped"),
    },
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // preventDefault as well: BrowseView's Escape listener sits on
      // document, where React's handlers do too, so stopPropagation cannot
      // reach it; it skips an Escape that is already handled.
      event.preventDefault();
      event.stopPropagation();
      onKeep();
      return;
    }
    if (event.key !== "Tab") return;
    // Two buttons, and Tab or Shift+Tab only ever moves between them.
    event.preventDefault();
    (document.activeElement === keepRef.current ? confirmRef : keepRef).current?.focus();
  };

  return createPortal(
    <div
      className={styles.overlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onKeep();
      }}
    >
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={facts.length > 0 ? `${showId} ${factsId} ${bodyId}` : `${showId} ${bodyId}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-unfollow-dialog
      >
        <h2 id={titleId} className={styles.heading}>
          {t("card.unfollowTitle")}
        </h2>
        <p id={showId} className={styles.show}>
          {title}
        </p>
        {facts.length > 0 ? (
          <p id={factsId} className={styles.facts}>
            {facts.join(" · ")}
          </p>
        ) : null}
        <p id={bodyId} className={styles.body}>
          {t("card.unfollowBody")}
        </p>
        <div className={styles.actions}>
          <button ref={keepRef} type="button" className={styles.keep} onClick={onKeep} data-unfollow-keep>
            {t("card.unfollowKeep")}
          </button>
          <button ref={confirmRef} type="button" className={styles.confirm} onClick={onConfirm} data-unfollow-confirm>
            {t("card.quickUnfollow")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
