"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import { patchMe } from "./settingsApi";
import { passPatch, type PassEditor, type PassFields } from "./settingsState";

function samePass(a: PassFields, b: PassFields): boolean {
  return a.photo === b.photo && a.backdrop === b.backdrop;
}

/**
 * The member pass's photo and backdrop: edited locally (the pass, the
 * preview and the identity line all follow the edit) until 保存.
 *
 * What counts as saved is kept here rather than read back from the page's
 * props. A saved photo goes up as a data: URL and comes back as an
 * /api/avatars URL, so comparing the edit with the props would put the save
 * bar straight back up after every photo save — the old page did exactly
 * that to its save button.
 */
export function usePassEditor(initial: PassFields): PassEditor {
  const router = useRouter();
  const { lang, t } = useLang();
  const [saved, setSaved] = useState<PassFields>(initial);
  const [edited, setEdited] = useState<PassFields>(initial);
  const [saving, setSaving] = useState(false);

  const setPhoto = useCallback((photo: string | null) => {
    setEdited((current) => (current.photo === photo ? current : { ...current, photo }));
  }, []);

  const setBackdrop = useCallback((backdrop: number) => {
    setEdited((current) => (current.backdrop === backdrop ? current : { ...current, backdrop }));
  }, []);

  const revert = useCallback(() => setEdited(saved), [saved]);

  const save = useCallback(async (): Promise<boolean> => {
    const body = passPatch(edited, saved);
    if (!body || saving) return false;
    const sent = edited;
    setSaving(true);
    const outcome = await patchMe(body, lang);
    setSaving(false);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return false;
    }
    const now = outcome.value ? { photo: outcome.value.photo, backdrop: outcome.value.backdrop } : sent;
    setSaved(now);
    // A change made while the request was out stays, still unsaved.
    setEdited((current) => (samePass(current, sent) ? now : current));
    toast.success(t("settings.passSaved"));
    // Keeps the router's copy of this page current for back/forward.
    router.refresh();
    return true;
  }, [edited, saved, saving, lang, t, router]);

  return {
    edited,
    dirty: passPatch(edited, saved) !== null,
    setPhoto,
    setBackdrop,
    revert,
    save,
  };
}
