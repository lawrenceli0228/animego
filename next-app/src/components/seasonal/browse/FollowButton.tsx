"use client";

// The cards' 追番 control, in the artboard's two places: the cover's corner
// and the chart card's footer.
//
// The behaviour is the site's one-tap subscribe (useQuickSubscribe), not the
// artboard's toggle: "+" writes a subscription (signed out, it stashes the
// intent and goes to log in, and an Undo in the toast takes a mis-tap back);
// "✓" is a link to the detail page, which owns every other subscription verb.
// It never deletes from here — see QuickSubscribeToggle for why.
//
// Until the subscription set has loaded it renders nothing: guessing "not
// followed" would flash a + at readers who already follow the show, and the
// control is absolutely placed (or at the end of a row), so arriving late
// moves nothing.

import { useState } from "react";
import Link from "@/components/ui/LocaleLink";
import { detailTarget } from "@/components/anime/quickSubscribeState";
import { useQuickSubscribe } from "@/components/anime/useQuickSubscribe";
import { useLang } from "@/lib/lang-client";
import { CheckIcon, PlusIcon } from "./icons";
import type { FollowSlotProps } from "./types";
import cards from "./cards.module.css";

export default function FollowButton({ anilistId, title, variant }: FollowSlotProps) {
  const { t } = useLang();
  const { ready, mode, busy, press } = useQuickSubscribe(anilistId);
  // Pressed on this page: the ✓ that follows is announced with the check and
  // ring. Shows already followed when the page loaded simply show their ✓.
  const [pressed, setPressed] = useState(false);

  if (!ready) return null;
  const cls = variant === "chart" ? cards.chAdd : cards.add;
  const icons = (
    <>
      <PlusIcon className={cards.iconPlus} />
      <CheckIcon className={cards.iconCheck} />
    </>
  );

  if (mode === "open") {
    return (
      <Link
        href={detailTarget(anilistId)}
        prefetch={false}
        className={cls}
        data-follow="on"
        data-fresh={pressed ? "true" : undefined}
        aria-label={`${t("card.quickAdded")} · ${t("detail.viewDetails")}: ${title}`}
      >
        {icons}
      </Link>
    );
  }

  const label = mode === "signedOut" ? t("card.quickAddLogin") : t("card.quickAdd");
  return (
    <button
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
  );
}
