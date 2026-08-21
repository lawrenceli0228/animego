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

// Keyed by Lang so a new language is a compile error rather than a silent
// fall-through to English. Local rather than a dictionary key: this component
// takes `lang` and not `dict`, and the string is one button's label.
const SHOW_MORE: Record<Lang, string> = {
  zh: "显示更多",
  en: "Show More",
  "zh-Hant": "顯示更多",
};

interface SeasonalShowMoreProps {
  lang: Lang;
  currentCount: number;
  step: number;
}

export default function SeasonalShowMore({ lang, currentCount, step }: SeasonalShowMoreProps) {
  const router = useRouter();
  const params = useSearchParams();
  const label = SHOW_MORE[lang];

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
