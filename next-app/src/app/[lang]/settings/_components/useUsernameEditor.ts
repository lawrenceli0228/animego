"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import { patchMe } from "./settingsApi";
import { canSaveName } from "./settingsState";

export interface UsernameEditor {
  /** The field's value, which the pass and the preview show as it is typed. */
  draft: string;
  setDraft: (value: string) => void;
  saved: string;
  /** The server shows a masked handle for this account and the field still holds it. */
  hidden: boolean;
  canSave: boolean;
  /** Resolves true once the server holds the new name. */
  save: () => Promise<boolean>;
}

/**
 * The username field. Saved explicitly (保存 appears once the trimmed value
 * differs and is long enough); the server's validation message is shown as
 * it comes, through the toast.
 */
export function useUsernameEditor(username: string, usernameHidden: boolean): UsernameEditor {
  const router = useRouter();
  const { lang, t } = useLang();
  const [draft, setDraft] = useState(username);
  const [saved, setSaved] = useState({ username, hidden: usernameHidden });
  const [saving, setSaving] = useState(false);

  const save = useCallback(async (): Promise<boolean> => {
    const name = draft.trim();
    if (saving || !canSaveName(name, saved.username)) return false;
    setSaving(true);
    const outcome = await patchMe({ username: name }, lang);
    setSaving(false);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return false;
    }
    const next = {
      username: outcome.value?.username ?? name,
      hidden: outcome.value?.usernameHidden ?? false,
    };
    setSaved(next);
    setDraft((current) => (current.trim() === name ? next.username : current));
    toast.success(t("settings.usernameSaved"));
    // Keeps the router's copy of this page current for back/forward.
    router.refresh();
    return true;
  }, [draft, saved.username, saving, lang, t, router]);

  return {
    draft,
    setDraft,
    saved: saved.username,
    // The server decides whether the name is hidden (go-api/internal/pii); it
    // is never re-derived here — a second copy of that rule would eventually
    // disagree with the Go one. Gated on the field still holding the handle,
    // so the warning clears the moment a replacement is typed.
    hidden: saved.hidden && draft.trim() === saved.username,
    canSave: canSaveName(draft, saved.username),
    save,
  };
}
