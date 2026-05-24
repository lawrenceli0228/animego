"use server";

// Server Actions for the enrichment queue control surface
// (EnrichmentBar). Mirrors legacy `client/src/api/admin.api.js`
// endpoints reEnrich / healCnTitles / pauseHeal / resumeHeal, but
// re-shapes the call sites as Server Functions so the Client
// Component can invoke them directly without React Query.
//
// All four endpoints sit behind RequireAuth+RequireAdmin in go-api
// (see docs/migration/P7-DESIGN.md §5). `apiMutate` forwards the
// browser session cookie, so authentication just works.

import { revalidatePath } from "next/cache";
import { ApiError, apiMutate } from "@/lib/api";
import {
  EnrichmentActionError,
  type HealCnResult,
  type PauseHealResult,
  type ReEnrichResult,
  type ResumeHealResult,
} from "./_shared";

function toActionError(action: string, err: unknown): EnrichmentActionError {
  if (err instanceof ApiError) {
    // Server-side breadcrumb for ops; the client only sees the
    // normalised message below.
    console.error(`[admin:${action}] ${err.code} ${err.status}`, err.message);
    return new EnrichmentActionError(err.code, err.message, err.status);
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  console.error(`[admin:${action}] unexpected`, err);
  return new EnrichmentActionError("UNEXPECTED", message, 500);
}

/**
 * Pause the V3 heal-CN batch. The go-api worker checks the paused
 * flag between rows, so this typically takes effect within ~1s.
 */
export async function pauseHealCn(): Promise<PauseHealResult> {
  try {
    const data = await apiMutate<PauseHealResult>(
      "/api/admin/enrichment/heal-cn/pause",
      "POST",
    );
    revalidatePath("/admin");
    return data;
  } catch (err) {
    throw toActionError("pauseHealCn", err);
  }
}

/**
 * Resume a paused V3 heal-CN batch.
 */
export async function resumeHealCn(): Promise<ResumeHealResult> {
  try {
    const data = await apiMutate<ResumeHealResult>(
      "/api/admin/enrichment/heal-cn/resume",
      "POST",
    );
    revalidatePath("/admin");
    return data;
  } catch (err) {
    throw toActionError("resumeHealCn", err);
  }
}

/**
 * Enqueue a V3 heal-CN batch over every row missing titleChinese.
 * Returns the number of rows queued; the bar's polling then drives
 * the live progress display.
 */
export async function healCn(): Promise<HealCnResult> {
  try {
    const data = await apiMutate<HealCnResult>(
      "/api/admin/enrichment/heal-cn",
      "POST",
    );
    revalidatePath("/admin");
    return data;
  } catch (err) {
    throw toActionError("healCn", err);
  }
}

/**
 * Re-enrich every row at the given version. v0 (full reset) is
 * intentionally not exposed in the EnrichmentBar UI — it'd wipe
 * every cache row and is reserved for an explicit operator flow.
 */
export async function reEnrich(version: 0 | 1 | 2): Promise<ReEnrichResult> {
  try {
    const data = await apiMutate<ReEnrichResult>(
      `/api/admin/enrichment/re-enrich?version=${version}`,
      "POST",
    );
    revalidatePath("/admin");
    return data;
  } catch (err) {
    throw toActionError("reEnrich", err);
  }
}
