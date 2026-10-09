"use client";

// Sending a draft: POST /api/edits through authFetch (an expired session is
// refreshed once; a dead one goes to /login and back), then back to the page.
// The source is checked first, in the browser, because it is the one field
// a submitter can forget and the server would refuse.

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { authFetch } from "@/lib/authFetch";
import { useLang } from "@/lib/lang-client";
import { editErrorKey } from "@/lib/people/edit/errors";
import { submissionBody, validSource, type Changes, type Draft } from "@/lib/people/edit/model";

export function useEditSubmit(draft: Draft, diff: Changes, pageHref: string) {
  const { t } = useLang();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState(false);
  const sourceRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (busy || diff.count === 0) return;
    if (diff.invalid) {
      setError(t("peopleEdit.errors.invalid"));
      return;
    }
    if (!validSource(draft.sourceUrl)) {
      setSourceError(true);
      setError(null);
      sourceRef.current?.focus();
      return;
    }
    setSourceError(false);
    setError(null);
    setBusy(true);
    try {
      const res = await authFetch("/api/edits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submissionBody(draft, diff.changes)),
      });
      if (res.ok) {
        toast.success(t("peopleEdit.submitted"));
        router.push(pageHref);
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(t(editErrorKey(res.status, body?.error?.message)));
    } catch {
      setError(t("peopleEdit.errors.failed"));
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    sourceError,
    sourceRef,
    clearSourceError: () => setSourceError(false),
    submit,
  };
}
