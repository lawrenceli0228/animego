"use client";

import { useEffect, useRef, useState } from "react";
import Link from "@/components/ui/LocaleLink";
import toast from "react-hot-toast";
import { authFetch } from "@/lib/authFetch";
import { useLang } from "@/lib/lang-client";

interface BlockedUser {
  id: string;
  username: string;
}

type ListState = "loading" | "ready" | "failed";

/** 已拉黑用户: the heading and the list, under 隐私与社区. */
export default function BlockedUsersList() {
  const { t } = useLang();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [items, setItems] = useState<BlockedUser[]>([]);
  const [state, setState] = useState<ListState>("loading");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await authFetch("/api/blocks?limit=50", {
          skipRedirectOnFailure: true,
        });
        if (!response.ok) throw new Error(`blocks ${response.status}`);
        const json = (await response.json()) as { data?: { items?: BlockedUser[] } };
        if (cancelled) return;
        setItems(Array.isArray(json.data?.items) ? json.data.items : []);
        setState("ready");
      } catch {
        // Said, not shown as "暂无拉黑用户": an empty list here would be a claim.
        if (!cancelled) setState("failed");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const unblock = async (username: string) => {
    if (busy) return;
    setBusy(username);
    try {
      const response = await authFetch(
        `/api/users/${encodeURIComponent(username)}/block`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("unblock failed");
      // The row and its button go; focus goes to the heading, not to nowhere.
      headingRef.current?.focus({ preventScroll: true });
      setItems((before) => before.filter((item) => item.username !== username));
      toast.success(t("safety.unblocked"));
    } catch {
      toast.error(t("safety.blockFailed"));
    } finally {
      setBusy(null);
    }
  };

  let body;
  if (state === "loading") {
    body = <p className="set-empty">…</p>;
  } else if (state === "failed") {
    body = <p className="set-empty">{t("settings.blockedLoadFailed")}</p>;
  } else if (items.length === 0) {
    body = <p className="set-empty">{t("settings.noBlockedUsers")}</p>;
  } else {
    body = (
      // role="list": Safari drops a styled-away <ul>'s list semantics otherwise.
      <ul className="set-list" role="list">
        {items.map((item) => (
          <li key={item.id} className="set-row">
            <div className="set-row-main">
              <Link href={`/u/${encodeURIComponent(item.username)}`} className="set-link">
                @{item.username}
              </Link>
            </div>
            <div className="set-row-end">
              <button
                type="button"
                className="set-btn ghost sm"
                aria-label={`${t("safety.unblock")} @${item.username}`}
                onClick={() => void unblock(item.username)}
              >
                {t("safety.unblock")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <h3 className="set-sub" ref={headingRef} tabIndex={-1}>
        {t("settings.blockedUsers")}
      </h3>
      <div className="set-group" aria-busy={state === "loading"}>
        {body}
      </div>
    </>
  );
}
