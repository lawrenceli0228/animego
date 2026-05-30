"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n";
import { ApiError } from "@/lib/api";

interface FollowButtonProps {
  username: string;
  /** null = anon viewer (backend OptionalAuth) */
  initialIsFollowing: boolean | null;
  /** true when the viewing user IS the profile owner — hides the button */
  isSelf: boolean;
  lang: Lang;
}

export default function FollowButton({
  username,
  initialIsFollowing,
  isSelf,
  lang: _serverLang,
}: FollowButtonProps) {
  const router = useRouter();
  const { t } = useLang();

  const [isFollowing, setIsFollowing] = useState<boolean | null>(initialIsFollowing);
  const [isPending, setIsPending] = useState(false);

  // Own profile — render nothing (mirrors legacy FollowButton.jsx:13)
  if (isSelf) return null;

  const handleClick = async () => {
    // Not logged in → redirect to login (mirrors legacy: !user → navigate('/login'))
    if (isFollowing === null) {
      router.push("/login");
      return;
    }

    setIsPending(true);
    const optimistic = !isFollowing;
    setIsFollowing(optimistic);

    const method = optimistic ? "POST" : "DELETE";
    try {
      const res = await fetch(`/api/users/${username}/follow`, {
        method,
        headers: { Accept: "application/json" },
        credentials: "include",
      });

      if (!res.ok) {
        // Roll back
        setIsFollowing(!optimistic);
        const key = optimistic ? "social.followFailed" : "social.unfollowFailed";
        toast.error(t(key));
        return;
      }

      const toastKey = optimistic ? "social.followedToast" : "social.unfollowedToast";
      toast(t(toastKey));
      // Refresh server data so followerCount in the header updates
      router.refresh();
    } catch (err) {
      setIsFollowing(!optimistic);
      const key = optimistic ? "social.followFailed" : "social.unfollowFailed";
      toast.error(
        err instanceof ApiError ? err.message : t(key),
      );
    } finally {
      setIsPending(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      aria-pressed={isFollowing === true}
      style={{
        padding: "8px 20px",
        borderRadius: 8,
        border: isFollowing ? "1px solid rgba(84,84,88,0.65)" : "none",
        background: isFollowing ? "transparent" : "#0a84ff",
        color: isFollowing ? "rgba(235,235,245,0.60)" : "#fff",
        fontSize: 13,
        fontWeight: 600,
        cursor: isPending ? "wait" : "pointer",
        transition: "all 0.2s",
        flexShrink: 0,
        minWidth: 88,
        // Subtle hover lift for the follow (solid) state
        ...(isFollowing
          ? {}
          : {}),
      }}
    >
      {isPending
        ? "..."
        : isFollowing
        ? t("social.unfollow")
        : t("social.follow")}
    </button>
  );
}
