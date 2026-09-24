"use client";

// The hero's "追番" — the glass half of the hero's two buttons.
//
// Same behaviour as the poster-corner + (useQuickSubscribe): signed out it
// stashes the intent and goes to /login; signed in it writes a `watching` row
// and confirms with an Undo toast; already tracked it is a link to the detail
// page, never a toggle that deletes.
//
// Unlike the corner button it always renders, because it sits in a row next
// to the solid button and disappearing would shift that row. Before the
// subscription set has loaded it is inert (aria-disabled, press ignored) — a
// press then would otherwise read as "signed out" and bounce a signed-in
// reader to /login.

import Link from "@/components/ui/LocaleLink";
import { detailTarget } from "@/components/anime/quickSubscribeState";
import { useQuickSubscribe } from "@/components/anime/useQuickSubscribe";
import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import { CheckIcon, PlusIcon } from "./icons";

interface HeroFollowButtonProps {
  anilistId: number;
  /** Already language-resolved; used in the accessible name. */
  title: string;
  /** The reader's current episode, when the server knows it. */
  progress?: number;
  className: string;
}

export default function HeroFollowButton({ anilistId, title, progress, className }: HeroFollowButtonProps) {
  const { t } = useLang();
  const { ready, mode, busy, press } = useQuickSubscribe(anilistId);

  if (ready && mode === "open") {
    const label = progress && progress > 0 ? fillTemplate(t("home.heroWatching"), { ep: progress }) : t("card.quickAdded");
    return (
      <Link
        href={detailTarget(anilistId)}
        prefetch={false}
        className={className}
        aria-label={`${label} · ${t("detail.viewDetails")}: ${title}`}
      >
        <CheckIcon />
        {label}
      </Link>
    );
  }

  const name = mode === "signedOut" && ready ? t("card.quickAddLogin") : t("card.quickAdd");
  return (
    <button
      type="button"
      className={className}
      // aria-disabled, not disabled: disabled drops focus to <body> mid-write.
      aria-disabled={!ready || busy}
      aria-label={`${name}: ${title}`}
      onClick={() => void press()}
    >
      <PlusIcon />
      {t("card.quickAdd")}
    </button>
  );
}
