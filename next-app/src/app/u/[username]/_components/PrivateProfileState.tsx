"use client";

import { useLang } from "@/lib/lang-client";

export default function PrivateProfileState() {
  const { t } = useLang();
  return (
    <section
      style={{
        marginTop: 8,
        marginBottom: 60,
        padding: "54px 20px",
        borderRadius: 14,
        border: "1px solid rgba(84,84,88,0.65)",
        background: "rgba(28,28,30,0.72)",
        textAlign: "center",
      }}
      aria-label={t("profile.privateTitle")}
    >
      <div aria-hidden="true" style={{ fontSize: 30, marginBottom: 12 }}>◉</div>
      <h2 style={{ margin: "0 0 8px", color: "#fff", fontSize: 18 }}>
        {t("profile.privateTitle")}
      </h2>
      <p style={{ margin: 0, color: "rgba(235,235,245,0.48)", fontSize: 13, lineHeight: 1.6 }}>
        {t("profile.privateBody")}
      </p>
    </section>
  );
}
