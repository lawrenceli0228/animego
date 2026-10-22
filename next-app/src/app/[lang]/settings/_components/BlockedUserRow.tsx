"use client";

import Link from "@/components/ui/LocaleLink";
import { useLang } from "@/lib/lang-client";

interface BlockedUserRowProps {
  username: string;
  /** An unblock for this row is out. */
  busy: boolean;
  /** Called with the row's element, so focus can be moved out of it when it goes. */
  onUnblock: (username: string, row: HTMLElement | null) => void;
}

/** One blocked account: a link to its profile and 解除拉黑. */
export default function BlockedUserRow({ username, busy, onUnblock }: BlockedUserRowProps) {
  const { t } = useLang();
  return (
    <li className="set-row" aria-busy={busy || undefined}>
      <div className="set-row-main">
        <Link href={`/u/${encodeURIComponent(username)}`} className="set-link">
          @{username}
        </Link>
      </div>
      <div className="set-row-end">
        {/* aria-disabled while it is out, not disabled: focus stays on it. */}
        <button
          type="button"
          className="set-btn ghost sm"
          aria-label={`${t("safety.unblock")} @${username}`}
          aria-disabled={busy || undefined}
          onClick={(event) => {
            if (!busy) onUnblock(username, event.currentTarget.closest("li"));
          }}
        >
          {t("safety.unblock")}
        </button>
      </div>
    </li>
  );
}
