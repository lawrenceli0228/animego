"use client";

import toast from "react-hot-toast";
import { useLang } from "@/lib/lang-client";

interface ShareButtonIslandProps {
  username: string;
  shareLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
}

export default function ShareButtonIsland({
  username,
  shareLabel,
  copiedLabel,
  copyFailedLabel,
}: ShareButtonIslandProps) {
  const { t: _t } = useLang(); // keep lang context hydrated

  const handle = async () => {
    const url = `${window.location.origin}/u/${encodeURIComponent(username)}`;
    const title = `${username} — AnimeGoClub`;

    if (navigator.share) {
      try {
        await navigator.share({ title, url });
      } catch {
        // user cancelled — do nothing
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      toast(copiedLabel);
    } catch {
      toast.error(copyFailedLabel);
    }
  };

  return (
    <button
      onClick={handle}
      style={{
        padding: "8px 14px",
        borderRadius: 8,
        border: "1px solid rgba(84,84,88,0.65)",
        background: "transparent",
        color: "rgba(235,235,245,0.60)",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {shareLabel}
    </button>
  );
}
