"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import ReportDialog from "@/components/safety/ReportDialog";
import { authFetch } from "@/lib/authFetch";
import { useLang } from "@/lib/lang-client";

interface ProfileSafetyActionsProps {
  username: string;
  authenticated: boolean;
  isSelf: boolean;
  isBlocked: boolean;
  blockedByViewer: boolean;
}

export default function ProfileSafetyActions({
  username,
  authenticated,
  isSelf,
  isBlocked,
  blockedByViewer,
}: ProfileSafetyActionsProps) {
  const { t } = useLang();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);

  if (isSelf) return null;

  const toggleBlock = async () => {
    if (!authenticated || pending || (isBlocked && !blockedByViewer)) return;
    if (!blockedByViewer && !confirmBlock) {
      setConfirmBlock(true);
      return;
    }
    setPending(true);
    try {
      const response = await authFetch(
        `/api/users/${encodeURIComponent(username)}/block`,
        { method: blockedByViewer ? "DELETE" : "PUT" },
      );
      if (!response.ok) throw new Error("block failed");
      toast.success(t(blockedByViewer ? "safety.unblocked" : "safety.blocked"));
      setConfirmBlock(false);
      router.refresh();
    } catch {
      toast.error(t("safety.blockFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
      <ReportDialog targetType="user" targetId={username} authenticated={authenticated} />
      {authenticated && (
        <button
          type="button"
          onClick={() => void toggleBlock()}
          disabled={pending || (isBlocked && !blockedByViewer)}
          style={{
            border: 0,
            background: "none",
            color: "rgba(255,69,58,0.82)",
            cursor: pending || (isBlocked && !blockedByViewer) ? "default" : "pointer",
            fontSize: 11,
            padding: 0,
            opacity: isBlocked && !blockedByViewer ? 0.6 : 1,
          }}
        >
          {pending
            ? "…"
            : isBlocked && !blockedByViewer
              ? t("safety.blockedByUser")
              : confirmBlock
                ? t("safety.confirmBlock")
                : t(blockedByViewer ? "safety.unblock" : "safety.block")}
        </button>
      )}
    </div>
  );
}
