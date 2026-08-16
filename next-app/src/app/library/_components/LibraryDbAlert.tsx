"use client";

/**
 * The user-facing surface for "the local library will not open".
 *
 * Until this existed, `dbOpenErrors.js` produced two carefully-worded messages
 * that nothing rendered. The failure they describe (design doc §9 CG3) is the
 * worst-looking one in the feature: the grid sits empty or spins, and a user
 * whose entire library is on their own disk concludes it was deleted.
 *
 * TWO SIGNALS, AND THE FIRST IS THE IMPORTANT ONE:
 *
 *   onLibraryDbBlocked  A second tab on an older build is holding the old
 *     connection and the v6 upgrade cannot proceed. This is the only signal
 *     that reaches anybody: Dexie's auto-open path is `db.open().catch(nop)`
 *     followed by an await on its own internal ready-promise
 *     (`dexie.js:1185-1188`), so the rejection from db.js's open wrapper is
 *     swallowed and every query simply never settles. There is no error to
 *     catch — which is exactly why db.js emits an event instead.
 *
 *   db.open() rejection  Everything else: quota exhausted, a private window
 *     with IndexedDB disabled, an upgrade function that threw. Dexie's open is
 *     idempotent, so asking for it here is free, and this branch is the only
 *     way the second message is ever seen.
 *
 * The copy lives in the -spa dictionaries (`library.dbBlocked` /
 * `library.dbOpenFailed`), not in `dbOpenErrors.js`. That module keeps its own
 * constants as the developer-facing / Sentry text — it is the data layer and
 * must stay importable from a `bun test` with no React and no browser, so it
 * cannot reach for `t()`. The duplication is deliberate and cross-referenced
 * from all three files; change them together.
 */

import { useEffect, useState } from "react";

import { useLang } from "@/lib/lang-client";
import { mono } from "@/components/landing/shared/hud-tokens";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JS module with JSDoc types
import { db, onLibraryDbBlocked } from "@/lib/library/db/db.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { isDbBlockedError } from "@/lib/library/db/dbOpenErrors.js";

const RED_HUE = 25;

type DbAlertKind = "blocked" | "failed";

export function LibraryDbAlert() {
  const { t } = useLang();
  const [kind, setKind] = useState<DbAlertKind | null>(null);

  useEffect(() => {
    let live = true;

    // `blocked: false` arrives when the other tab finally lets go, so the
    // banner takes itself down without any extra bookkeeping here.
    const unsubscribe = onLibraryDbBlocked(
      (state: { blocked: boolean }) => {
        if (!live) return;
        setKind(state.blocked ? "blocked" : null);
      },
    );

    // Idempotent: returns the in-flight or already-resolved open promise.
    Promise.resolve(db.open()).then(
      () => {
        if (live) setKind((prev) => (prev === "failed" ? null : prev));
      },
      (err: unknown) => {
        if (!live) return;
        // A blocked upgrade rejects here too once the grace period lapses;
        // the event already said so, and it says it better.
        setKind(isDbBlockedError(err) ? "blocked" : "failed");
      },
    );

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  if (!kind) return null;

  return (
    <div style={s.banner} role="alert" data-testid="library-db-alert" data-kind={kind}>
      <span style={s.text}>
        {kind === "blocked" ? t("library.dbBlocked") : t("library.dbOpenFailed")}
      </span>
    </div>
  );
}

export default LibraryDbAlert;

const s: Record<string, React.CSSProperties> = {
  banner: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    background: `oklch(62% 0.19 ${RED_HUE} / 0.15)`,
    border: `1px solid oklch(62% 0.19 ${RED_HUE} / 0.45)`,
    borderRadius: 4,
  },
  text: {
    ...mono,
    fontSize: 11,
    lineHeight: 1.6,
    color: `oklch(76% 0.15 ${RED_HUE})`,
    letterSpacing: "0.05em",
  },
};
