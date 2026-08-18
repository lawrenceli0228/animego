"use client";

import { useEffect, useState } from "react";
import Link from "@/components/ui/LocaleLink";
import toast from "react-hot-toast";
import { authFetch } from "@/lib/authFetch";
import { useLang } from "@/lib/lang-client";

interface BlockedUser {
  id: string;
  username: string;
}

export default function BlockedUsersList() {
  const { t } = useLang();
  const [items, setItems] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await authFetch("/api/blocks?limit=50", {
          skipRedirectOnFailure: true,
        });
        if (!response.ok) return;
        const json = (await response.json()) as { data?: { items?: BlockedUser[] } };
        if (!cancelled) setItems(Array.isArray(json.data?.items) ? json.data.items : []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const unblock = async (username: string) => {
    setBusy(username);
    try {
      const response = await authFetch(
        `/api/users/${encodeURIComponent(username)}/block`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("unblock failed");
      setItems((before) => before.filter((item) => item.username !== username));
      toast.success(t("safety.unblocked"));
    } catch {
      toast.error(t("safety.blockFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ marginTop: 20, borderTop: "1px solid #38383a", paddingTop: 16 }}>
      <b style={{ display: "block", color: "#fff", fontSize: 13.5 }}>
        {t("settings.blockedUsers")}
      </b>
      {loading ? (
        <p className="hint">…</p>
      ) : items.length === 0 ? (
        <p className="hint">{t("settings.noBlockedUsers")}</p>
      ) : (
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          {items.map((item) => (
            <div
              key={item.id}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
            >
              <Link
                href={`/u/${encodeURIComponent(item.username)}`}
                style={{ color: "#0a84ff", fontSize: 13, textDecoration: "none" }}
              >
                @{item.username}
              </Link>
              <button
                type="button"
                className="set-btn ghost"
                disabled={busy === item.username}
                onClick={() => void unblock(item.username)}
              >
                {busy === item.username ? "…" : t("safety.unblock")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
