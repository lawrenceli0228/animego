"use client";

import { useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { useLang } from "@/lib/lang-client";
import { BCP47_TAG } from "@/lib/i18n/lang";

export interface AdminReport {
  id: string;
  reporterUsername: string;
  targetType: "comment" | "user";
  targetSnapshot?: {
    username?: string;
    content?: string;
    isSpoiler?: boolean;
    anilistId?: number;
    episode?: number;
  };
  targetUsername?: string | null;
  targetCommentContent?: string | null;
  reason: string;
  details?: string | null;
  status: "pending" | "reviewing" | "resolved" | "dismissed";
  createdAt: string;
}

export interface AdminReportsData {
  items: AdminReport[];
  hasMore: boolean;
  nextPage: number | null;
}

export default function ReportsSection({ initial }: { initial: AdminReportsData }) {
  const { lang, t } = useLang();
  const [items, setItems] = useState(
    initial.items.filter((item) => item.status === "pending" || item.status === "reviewing"),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update = async (id: string, status: "reviewing" | "resolved" | "dismissed") => {
    setBusy(id);
    setError(null);
    try {
      const response = await authFetch(`/api/admin/reports/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error("update failed");
      setItems((before) =>
        status === "reviewing"
          ? before.map((item) => (item.id === id ? { ...item, status } : item))
          : before.filter((item) => item.id !== id),
      );
    } catch {
      setError(t("admin.reportsUpdateFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section id="reports" aria-labelledby="reports-heading">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <h2 id="reports-heading" style={{ margin: 0, color: "#a8a8b8", fontSize: 14, textTransform: "uppercase", letterSpacing: 0.8 }}>
          {t("admin.reportsTitle")}
        </h2>
        <span style={{ color: "#6f6f7e", fontSize: 12 }}>{items.length}</span>
      </div>
      {error && <p style={{ color: "#ff9f9f", fontSize: 12 }}>{error}</p>}
      {items.length === 0 ? (
        <p style={{ color: "#6f6f7e", fontSize: 13 }}>{t("admin.reportsEmpty")}</p>
      ) : (
        <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
          {items.map((report) => {
            const snapshot = report.targetSnapshot ?? {};
            const username = report.targetUsername ?? snapshot.username ?? "—";
            const content = report.targetCommentContent ?? snapshot.content;
            return (
              <article key={report.id} style={{ border: "1px solid #292934", borderRadius: 8, background: "#15151d", padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <b style={{ color: "#eee", fontSize: 13 }}>@{username}</b>
                  <span style={{ color: "#777789", fontSize: 11 }}>
                    {report.reason} · {new Date(report.createdAt).toLocaleString(BCP47_TAG[lang])}
                  </span>
                </div>
                {content && (
                  <p style={{ margin: "10px 0 0", color: "#b8b8c4", whiteSpace: "pre-wrap", fontSize: 12.5 }}>
                    {snapshot.isSpoiler ? `⚠ ${t("admin.reportSpoiler")} · ` : ""}{content}
                  </p>
                )}
                {report.details && (
                  <p style={{ margin: "8px 0 0", color: "#8f8fa0", fontSize: 12 }}>
                    {t("admin.reportDetails")}: {report.details}
                  </p>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                  <span style={{ color: "#777789", fontSize: 11 }}>
                    {t("admin.reportedBy")} @{report.reporterUsername} · {report.status}
                  </span>
                  <div style={{ display: "flex", gap: 7 }}>
                    {report.status === "pending" && (
                      <button type="button" disabled={busy === report.id} onClick={() => void update(report.id, "reviewing")} style={buttonStyle}>
                        {t("admin.reportReview")}
                      </button>
                    )}
                    <button type="button" disabled={busy === report.id} onClick={() => void update(report.id, "dismissed")} style={buttonStyle}>
                      {t("admin.reportDismiss")}
                    </button>
                    <button type="button" disabled={busy === report.id} onClick={() => void update(report.id, "resolved")} style={{ ...buttonStyle, color: "#30d158" }}>
                      {t("admin.reportResolve")}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

const buttonStyle: React.CSSProperties = {
  border: "1px solid #343440",
  borderRadius: 6,
  background: "#20202a",
  color: "#c7c7d2",
  padding: "5px 9px",
  fontSize: 11,
  cursor: "pointer",
};
