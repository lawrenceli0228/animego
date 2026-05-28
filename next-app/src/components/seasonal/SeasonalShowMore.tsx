"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { CSSProperties } from "react";
import type { Lang } from "@/lib/i18n";

const wrapStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  marginTop: 32,
};

const btnStyle: CSSProperties = {
  padding: "10px 36px",
  borderRadius: 10,
  border: "1px solid #38383a",
  background: "rgba(120,120,128,0.08)",
  color: "rgba(235,235,245,0.60)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 0.2s",
};

interface SeasonalShowMoreProps {
  lang: Lang;
  currentCount: number;
  step: number;
}

export default function SeasonalShowMore({ lang, currentCount, step }: SeasonalShowMoreProps) {
  const router = useRouter();
  const params = useSearchParams();
  const label = lang === "zh" ? "显示更多" : "Show More";

  function handleClick() {
    const next = new URLSearchParams(params.toString());
    next.set("show", String(currentCount + step));
    router.replace(`?${next.toString()}`, { scroll: false });
  }

  return (
    <div style={wrapStyle}>
      <button type="button" style={btnStyle} onClick={handleClick}>
        {label}
      </button>
    </div>
  );
}
