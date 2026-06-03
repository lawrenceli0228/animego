"use client";

import Link from "next/link";
import type { FollowListItem } from "./types";
import FollowButton from "./FollowButton";
import type { Lang } from "@/lib/i18n";
import { DEFAULT_CARD_IMAGE } from "@/lib/cardDefaults";
import FallbackImg from "@/components/ui/FallbackImg";

interface FollowListRowProps {
  user: FollowListItem;
  /** Whether the app-user (viewer) is following this row's user; null = anon */
  viewerIsFollowing: boolean | null;
  /** The viewer's own username — hides FollowButton for self-rows */
  viewerUsername: string | null;
  lang: Lang;
}

export default function FollowListRow({
  user,
  viewerIsFollowing,
  viewerUsername,
  lang,
}: FollowListRowProps) {
  const isSelf = viewerUsername === user.username;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        borderRadius: 10,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid #38383a",
        transition: "border-color 0.15s, background 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(10,132,255,0.4)";
        (e.currentTarget as HTMLDivElement).style.background = "rgba(10,132,255,0.06)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = "#38383a";
        (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.03)";
      }}
    >
      {/* Avatar */}
      <Link
        href={`/u/${user.username}`}
        style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 12, flex: 1 }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            flexShrink: 0,
            background: "#0a84ff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 15,
            fontWeight: 800,
            color: "#fff",
            textTransform: "uppercase",
            overflow: "hidden",
          }}
        >
          <FallbackImg
            src={user.avatarUrl ?? user.backdropCoverUrl ?? DEFAULT_CARD_IMAGE}
            fallback={DEFAULT_CARD_IMAGE}
            alt={user.username}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </div>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#ffffff" }}>
          {user.username}
        </span>
      </Link>

      {/* Follow/Unfollow button for this row user */}
      <FollowButton
        username={user.username}
        initialIsFollowing={viewerIsFollowing}
        isSelf={isSelf}
        lang={lang}
      />
    </div>
  );
}
