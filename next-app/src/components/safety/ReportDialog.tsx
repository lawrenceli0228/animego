"use client";

import { useId, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import { authFetch } from "@/lib/authFetch";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";

type ReportTargetType = "comment" | "user";

interface ReportDialogProps {
  targetType: ReportTargetType;
  targetId: string;
  authenticated: boolean;
}

const REASONS = [
  "spam",
  "harassment",
  "hate_speech",
  "sexual_content",
  "violence",
  "spoiler",
  "misinformation",
  "other",
] as const;

// Inner map is keyed by Lang, not by loose zh/en fields, because the read site
// is an unguarded double index (`LABELS[value][lang]`). Under a language the
// inner object lacks, that expression renders an empty <option> — a reporter
// picking a blank reason — with no crash or warning. Typing it as Record<Lang,…>
// turns that into a compile error at the table instead.
const LABELS: Record<(typeof REASONS)[number], Record<Lang, string>> = {
  spam: { zh: "垃圾广告", en: "Spam" },
  harassment: { zh: "骚扰或人身攻击", en: "Harassment" },
  hate_speech: { zh: "仇恨言论", en: "Hate speech" },
  sexual_content: { zh: "色情内容", en: "Sexual content" },
  violence: { zh: "暴力内容", en: "Violence" },
  spoiler: { zh: "未标注剧透", en: "Unmarked spoiler" },
  misinformation: { zh: "误导信息", en: "Misinformation" },
  other: { zh: "其他", en: "Other" },
};

export default function ReportDialog({
  targetType,
  targetId,
  authenticated,
}: ReportDialogProps) {
  const { lang, t } = useLang();
  const pathname = usePathname();
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("spam");
  const [details, setDetails] = useState("");
  const [pending, setPending] = useState(false);

  const begin = () => {
    if (!authenticated) {
      router.push(authHrefWithFrom("/login", pathname));
      return;
    }
    setOpen(true);
  };

  const submit = async () => {
    if (pending) return;
    setPending(true);
    try {
      const response = await authFetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType,
          targetId,
          reason,
          details: details.trim() || undefined,
        }),
      });
      if (!response.ok) throw new Error("report failed");
      setOpen(false);
      setDetails("");
      toast.success(t("safety.reported"));
    } catch {
      toast.error(t("safety.reportFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={begin}
        style={{
          border: 0,
          background: "none",
          color: "rgba(235,235,245,0.36)",
          cursor: "pointer",
          fontSize: 11,
          padding: 0,
        }}
      >
        {t("safety.report")}
      </button>
      {open && (
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1100,
            display: "grid",
            placeItems: "center",
            padding: 20,
            background: "rgba(0,0,0,0.68)",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            style={{
              width: "min(420px, 100%)",
              borderRadius: 14,
              border: "1px solid #3a3a3c",
              background: "#1c1c1e",
              boxShadow: "0 24px 70px rgba(0,0,0,0.5)",
              padding: 20,
            }}
          >
            <h2 id={titleId} style={{ margin: "0 0 6px", color: "#fff", fontSize: 18 }}>
              {t("safety.reportTitle")}
            </h2>
            <p style={{ margin: "0 0 16px", color: "rgba(235,235,245,0.48)", fontSize: 12.5 }}>
              {t("safety.reportPrivacy")}
            </p>
            <label style={{ display: "grid", gap: 7, color: "rgba(235,235,245,0.72)", fontSize: 12.5 }}>
              {t("safety.reason")}
              <select
                value={reason}
                onChange={(event) => setReason(event.target.value as (typeof REASONS)[number])}
                style={{
                  height: 40,
                  borderRadius: 8,
                  border: "1px solid #48484a",
                  background: "#2c2c2e",
                  color: "#fff",
                  padding: "0 10px",
                }}
              >
                {REASONS.map((value) => (
                  <option key={value} value={value}>
                    {LABELS[value][lang]}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 7, marginTop: 14, color: "rgba(235,235,245,0.72)", fontSize: 12.5 }}>
              {t("safety.details")}
              <textarea
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                maxLength={500}
                rows={4}
                placeholder={t("safety.detailsPlaceholder")}
                style={{
                  resize: "vertical",
                  borderRadius: 8,
                  border: "1px solid #48484a",
                  background: "#2c2c2e",
                  color: "#fff",
                  padding: 10,
                  font: "inherit",
                }}
              />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 18 }}>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                style={{ border: 0, borderRadius: 8, padding: "8px 14px", background: "#2c2c2e", color: "#fff" }}
              >
                {t("comment.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={pending}
                style={{ border: 0, borderRadius: 8, padding: "8px 14px", background: "#ff453a", color: "#fff", fontWeight: 650 }}
              >
                {pending ? t("safety.submitting") : t("safety.submitReport")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
