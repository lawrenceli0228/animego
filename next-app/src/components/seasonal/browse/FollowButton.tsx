"use client";

// The cards' 追番 control, in the artboard's two places: the cover's corner
// and the chart card's footer.
//
// The artboard's toggle, on the site's one-tap subscribe (useQuickSubscribe):
// "+" writes a subscription (signed out, it stashes the intent and goes to log
// in, and an Undo in the toast takes a mis-tap back); "✓" unfollows. A row
// holding nothing but the follow goes at once, with an Undo; one holding
// progress, a score, another status or a conversation is kept by the server
// (DELETE ?ifUntouched=1 answers 409), and the reader is asked before the
// plain DELETE takes all of that — see QuickSubscribeToggle for why a poster
// corner never deletes blind.
//
// Until the subscription set has loaded it renders nothing: guessing "not
// followed" would flash a + at readers who already follow the show, and the
// control is absolutely placed (or at the end of a row), so arriving late
// moves nothing.

import { useRef, useState } from "react";
import { useQuickSubscribe } from "@/components/anime/useQuickSubscribe";
import { useLang } from "@/lib/lang-client";
import type { SubscriptionDoc } from "@/lib/subscriptionBus";
import { CheckIcon, PlusIcon } from "./icons";
import type { FollowSlotProps } from "./types";
import UnfollowDialog from "./UnfollowDialog";
import cards from "./cards.module.css";

export default function FollowButton({ anilistId, title, variant }: FollowSlotProps) {
  const { t } = useLang();
  const { ready, mode, busy, press, unfollow, unfollowAnyway } = useQuickSubscribe(anilistId);
  // Pressed on this page: the ✓ that follows is announced with the check and
  // ring. Shows already followed when the page loaded simply show their ✓.
  const [pressed, setPressed] = useState(false);
  // The question that is open, with what the kept row holds.
  const [asking, setAsking] = useState<{ doc: SubscriptionDoc | null } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  if (!ready) return null;
  const cls = variant === "chart" ? cards.chAdd : cards.add;
  const icons = (
    <>
      <PlusIcon className={cards.iconPlus} />
      <CheckIcon className={cards.iconCheck} />
    </>
  );

  const dialog = asking ? (
    <UnfollowDialog
      title={title}
      doc={asking.doc}
      returnFocusTo={triggerRef}
      onKeep={() => setAsking(null)}
      onConfirm={() => {
        setAsking(null);
        void unfollowAnyway();
      }}
    />
  ) : null;

  if (mode === "open") {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          className={cls}
          data-follow="on"
          data-fresh={pressed ? "true" : undefined}
          aria-disabled={busy}
          aria-label={`${t("card.quickUnfollow")}: ${title}`}
          onClick={async () => {
            const outcome = await unfollow();
            if (outcome.kind === "ask") setAsking({ doc: outcome.doc });
          }}
        >
          {icons}
        </button>
        {dialog}
      </>
    );
  }

  const label = mode === "signedOut" ? t("card.quickAddLogin") : t("card.quickAdd");
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cls}
        data-follow="off"
        // aria-disabled, not disabled: `disabled` drops keyboard focus to <body>
        // in the middle of the write.
        aria-disabled={busy}
        aria-label={`${label}: ${title}`}
        onClick={() => {
          setPressed(true);
          void press();
        }}
      >
        {icons}
      </button>
      {dialog}
    </>
  );
}
