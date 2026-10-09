"use server";

// The review of a submitted edit (/admin/edits): POST
// /api/admin/edits/{id}/review, forwarded with the admin's session cookie
// (apiMutate); go-api checks the role again, so a non-admin calling this
// action gets go-api's 403 back.
//
// After a review that accepted anything, the page it was about is
// revalidated in every locale, so the accepted values are public at once
// rather than at the page's next ISR window. The anime pages that list the
// person or character follow on their own 60-second window: go-api has
// already dropped them from its detail cache.
//
// A result object rather than a thrown error: Next replaces a thrown
// action's message with a digest in production, and the panel needs the
// status to say what went wrong.

import { revalidatePath } from "next/cache";
import { ApiError, apiMutate } from "@/lib/api";
import { LOCALES, routerPath } from "@/lib/i18n/locale";
import { UUID, validReviewBody, type EditSubmission } from "@/lib/people/edit/review";
import { characterPath, personPath } from "@/lib/people/paths";

export type ReviewResult =
  | { ok: true; submission: EditSubmission }
  | { ok: false; status: number; message: string };

export async function reviewEditSubmission(id: string, body: unknown): Promise<ReviewResult> {
  if (!UUID.test(id) || !validReviewBody(body)) return { ok: false, status: 400, message: "" };
  try {
    const submission = await apiMutate<EditSubmission>(`/api/admin/edits/${id}/review`, "POST", { body });
    if (submission.acceptedCount > 0) {
      const path = submission.kind === "person" ? personPath(submission.entityId) : characterPath(submission.entityId);
      for (const locale of LOCALES) revalidatePath(routerPath(path, locale));
    }
    return { ok: true, submission };
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`[admin:reviewEdit] ${err.code} ${err.status}`, err.message);
      return { ok: false, status: err.status, message: err.message };
    }
    console.error("[admin:reviewEdit] unexpected", err);
    return { ok: false, status: 0, message: "" };
  }
}
