"use server";

// Server Action for the Traditional-Chinese drift block (HantDriftSection).
//
// The backfill has an automatic floor — a quarterly job — so this endpoint is
// not how the columns normally get filled. It exists for the case the
// dashboard is built around: an operator looking at a non-zero `descBehind`
// who does not want to wait up to three months for rows that are currently
// serving Simplified prose under a Traditional URL.
//
// Sits behind RequireAuth+RequireAdmin in go-api, same as every other action
// in this directory; `apiMutate` forwards the browser session cookie, so
// authentication just works.

import { revalidatePath } from "next/cache";
import { ApiError, apiMutate } from "@/lib/api";
import {
  EnrichmentActionError,
  type HantBackfillResult,
} from "./_shared";

// A local copy rather than a shared helper: sibling `"use server"` modules
// each carry their own (see enrichment-queue.ts, users.ts) because Next 16
// strips every non-async export from these files, so the only place to hoist
// it to is _shared.ts — and putting a console.error breadcrumb helper in the
// types module to save nine lines is a worse trade than this duplication.
function toActionError(action: string, err: unknown): EnrichmentActionError {
  if (err instanceof ApiError) {
    // Server-side breadcrumb for ops; the client only sees the normalised
    // message below.
    console.error(`[admin:${action}] ${err.code} ${err.status}`, err.message);
    return new EnrichmentActionError(err.code, err.message, err.status);
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  console.error(`[admin:${action}] unexpected`, err);
  return new EnrichmentActionError("UNEXPECTED", message, 500);
}

/**
 * Ask go-api to run the Traditional backfill now.
 *
 * Returns go-api's own envelope so the caller can print `message` verbatim —
 * "already running" and "queued 2 rows" are different facts and the block
 * shows whichever one it got. The section refetches
 * `/api/admin/hant/stats` immediately afterwards; `revalidatePath` is for the
 * next navigation, which is a different (slower) path and does not replace it.
 */
export async function runHantBackfill(): Promise<HantBackfillResult> {
  try {
    const data = await apiMutate<HantBackfillResult>(
      "/api/admin/hant/backfill",
      "POST",
    );
    revalidatePath("/admin");
    return data;
  } catch (err) {
    throw toActionError("runHantBackfill", err);
  }
}
