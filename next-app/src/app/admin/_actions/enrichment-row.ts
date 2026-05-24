"use server";

// Server Actions for per-row enrichment mutations. Mirrors the legacy
// `useAdmin.js` mutations (useUpdateEnrichment / useResetEnrichment /
// useFlagEnrichment) but driven by Next 16's Server Action RPC instead
// of React Query. Cache invalidation is explicit: each mutation
// revalidates the per-anime detail tag plus the enrichment list path
// so any open RSC view re-fetches on the next paint.
//
// Contract reference: docs/migration/P7-DESIGN.md §5 + §6.

import { revalidatePath, revalidateTag } from "next/cache";
import { apiMutate } from "@/lib/api";
import type { EnrichmentFlag, EnrichmentRow } from "../_types";

interface EnrichmentPatch {
  titleChinese?: string | null;
  bgmId?: number | null;
  bangumiScore?: number | null;
}

interface FlagResponse {
  anilistId: number;
  adminFlag: EnrichmentFlag;
}

interface ResetResponse {
  anilistId: number;
  reset: true;
}

/**
 * PATCH /api/admin/enrichment/{anilistId}
 *
 * Backend treats `undefined` as no-op, `null` as clear. The caller
 * should pass only fields it actually wants to change.
 */
export async function patchEnrichmentRow(
  anilistId: number,
  patch: EnrichmentPatch,
): Promise<EnrichmentRow> {
  const updated = await apiMutate<EnrichmentRow>(
    `/api/admin/enrichment/${anilistId}`,
    "PATCH",
    { body: patch },
  );
  // Next 16 made the second arg to revalidateTag mandatory. "max" gives
  // stale-while-revalidate semantics across consumers of this tag —
  // anime detail pages will fetch fresh data on next visit while the
  // current view still renders. For immediate read-your-own-writes
  // semantics use updateTag, but admin edits don't need that here.
  revalidateTag(`anime:detail:${anilistId}`, "max");
  revalidatePath("/admin/enrichment");
  return updated;
}

/**
 * POST /api/admin/enrichment/{anilistId}/flag
 *
 * Pass `null` to clear the flag. Backend accepts only
 * `"needs-review" | "manually-corrected" | null`.
 */
export async function flagEnrichmentRow(
  anilistId: number,
  flag: EnrichmentFlag,
): Promise<FlagResponse> {
  const res = await apiMutate<FlagResponse>(
    `/api/admin/enrichment/${anilistId}/flag`,
    "POST",
    { body: { flag } },
  );
  revalidateTag(`anime:detail:${anilistId}`, "max");
  revalidatePath("/admin/enrichment");
  return res;
}

/**
 * POST /api/admin/enrichment/{anilistId}/reset
 *
 * Clears enrichment fields and re-queues V1 enrichment. No body.
 */
export async function resetEnrichmentRow(
  anilistId: number,
): Promise<ResetResponse> {
  const res = await apiMutate<ResetResponse>(
    `/api/admin/enrichment/${anilistId}/reset`,
    "POST",
  );
  revalidateTag(`anime:detail:${anilistId}`, "max");
  revalidatePath("/admin/enrichment");
  return res;
}
