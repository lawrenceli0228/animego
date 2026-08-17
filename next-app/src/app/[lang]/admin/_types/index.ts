// Shape definitions for go-api admin endpoints. Mirrors
// docs/migration/P7-DESIGN.md §5 contract sheet. Keep these in sync
// with go-api/internal/admin/*.go response structs.

/**
 * Chinese-synopsis backfill, counted as *coverage* rather than as batch
 * progress: the sweep is perpetual, so there is no "batch total" and a
 * processed/total bar would display a fake completion figure.
 *
 * `eligible` is the row count of the `description_cn_eligible` view —
 * the single definition of "this row's bgm binding is trustworthy enough
 * to copy a synopsis from". Never re-derive that predicate elsewhere.
 *
 * The four numbers must stay reproducible by hand in SQL; the panel's
 * whole credibility rests on that.
 */
export interface DescriptionCnStats {
  /** Rows in the eligible view — the coverage denominator. */
  eligible: number;
  /** Eligible rows that already carry a Chinese synopsis. */
  done: number;
  /**
   * Attempted and still empty. Read the name narrowly: the worker stamps
   * `description_cn_attempted_at` on FOUR decided outcomes, not just the
   * language gate — no summary upstream at all, a summary that failed the
   * Chinese check, a 404 (stale binding), or a swallowed UPDATE error.
   *
   * A large steady value is normal (Japanese-only summaries). A CLIMBING
   * one is not: a mass 404 or a broken writer produces no retryable jobs,
   * so the queue block stays green and this counter is the only place the
   * breakage shows.
   */
  rejected: number;
  /**
   * Never attempted, or past its 30-day cooldown and due again — the
   * whole live backlog, not the next batch. Doubles as the discriminator
   * for the write heartbeat: silence with pending 0 is "nothing to do",
   * silence with pending > 0 is a wedged writer.
   *
   * Overlaps `rejected` on purpose (a row decided against more than 30
   * days ago is in both) — the two must never be summed.
   */
  pending: number;
}

/**
 * Depth of the `description_backfill` river queue, split by state, plus
 * the two heartbeats.
 *
 * States are kept apart on purpose: folding `retryable` into "queued"
 * makes an upstream outage read as a healthy backlog.
 *
 * Both heartbeats are needed. The scan timestamp answers "is it still
 * running", the write timestamp answers "did it accomplish anything" —
 * one alone cannot tell "nothing to do" apart from "dead".
 *
 * go-api always emits this object (a non-pointer struct), so it is typed
 * as required. The `??` fallback at the call site covers only the rolling
 * deploy window where next-app is new and go-api is not — it is load
 * bearing despite the type, do not "simplify" it away.
 */
export interface BackfillQueue {
  /** available + running + scheduled + pending. */
  queued: number;
  /** `retryable` — failed, waiting on a retry. Non-zero is an alarm. */
  retrying: number;
  /** Retries exhausted. Non-zero is an alarm. */
  discarded: number;
  /**
   * `max(finalized_at)` of a completed `description_backfill_scan`. river
   * prunes completed rows after its retention window (24h by default), so
   * null means "no scan has completed in at least 24h" rather than
   * literally never — either way it is the state worth alerting on.
   */
  lastScanAt: string | null;
  /**
   * `max(anime_cache.description_cn_attempted_at)` — when the sweep last
   * reached a decision about any row, hit or miss. Legitimately freezes
   * once the backlog drains, so it must never be read as liveness on its
   * own; pair it with `descriptionCn.pending`.
   */
  lastWriteAt: string | null;
}

/**
 * LLM translation tier coverage — the fallback that serves rows the
 * Bangumi channel never can (its subject carries no usable Chinese, or the
 * binding is not trustworthy enough to copy from in the first place).
 *
 * Deliberately NOT merged into DescriptionCnStats: the two tiers do not
 * share a denominator, and putting them in one object invites summing
 * numbers that count nearly disjoint sets of rows.
 */
export interface DescriptionCnLlmStats {
  /**
   * The rows this tier could ever write: English source text exists, the
   * row is still empty or already machine-translated, and the Bangumi
   * channel is done with it or can never reach it.
   *
   * NOT the catalogue, and NOT `DescriptionCnStats.eligible` — a row is in
   * exactly one tier's remit at a time, and a row Bangumi later fills with
   * human prose leaves this denominator on its own.
   */
  remit: number;
  /**
   * `description_cn_source = 'llm'`. Can legitimately go DOWN: machine
   * translations return to the Bangumi sweep's 30-day recheck, so human
   * prose replacing one is the covenant working, not data loss.
   */
  done: number;
  /**
   * In remit, still empty, LLM attempt stamped — the validation gate (Han
   * density / length) refused the model's output, or the source text
   * stripped to nothing.
   *
   * Climbing while `done` is flat means the model is returning text that
   * fails validation: check the logs rather than assuming it is normal
   * attrition. Transport failures never land here — those retry.
   */
  rejected: number;
  /**
   * In remit, still empty, never attempted or past the 30-day cooldown.
   * The live backlog, and the discriminator for this tier's write
   * heartbeat exactly as in the Bangumi block.
   *
   * Overlaps `rejected` by design; never sum them.
   */
  pending: number;
}

export interface AdminStats {
  users: number;
  anime: number;
  enrichment: {
    v0: number;
    v1: number;
    v2: number;
    v3: number;
    noCn: number;
    hasCn: number;
    healCnReal: number;
    cnStuck: number;
    srcIdMap: number;
    srcFuzzyHigh: number;
    srcFuzzyLow: number;
  };
  queue: {
    phase1: number;
    phase4: number;
    v3: number;
    v3Progress?: { processed: number; total: number; paused?: boolean };
    descriptionBackfill: BackfillQueue;
    /**
     * The LLM tier's queue, same three-state shape. Separate from
     * `descriptionBackfill` because the two sweeps fail for unrelated
     * reasons — one is throttled by bgm.tv, the other by a paid API that
     * can rate-limit, run out of credit, or retire a model. Fused, "out
     * of credit" would be indistinguishable from "bgm.tv is slow".
     */
    descriptionLlm: BackfillQueue;
  };
  descriptionCn: DescriptionCnStats;
  descriptionCnLlm: DescriptionCnLlmStats;
  flagged: number;
  subscriptions: number;
  follows: number;
}

export type EnrichmentFlag = "needs-review" | "manually-corrected" | null;

export interface EnrichmentRow {
  anilistId: number;
  titleRomaji: string | null;
  titleChinese: string | null;
  bgmId: number | null;
  bangumiVersion: number;
  bangumiScore: number | null;
  adminFlag: EnrichmentFlag;
  // How bgm_id was bound: "id_map" (authoritative) | "fuzzy_high" |
  // "fuzzy_low" (low-confidence, needs review) | null (unenriched).
  bgmMatchSource: string | null;
}

export interface PagedResponse<T> {
  data: T[];
  hasMore: boolean;
  total: number;
  page: number;
}

export type EnrichmentFilter =
  | "needs-review"
  | "manually-corrected"
  | "unenriched"
  | "no-cn";

export type EnrichmentSort =
  | "cachedAt"
  | "title_chinese"
  | "title_romaji"
  | "bangumi_version"
  | "bangumi_score"
  | "anilist_id"
  | "bgm_match_source";

export interface AdminUser {
  _id: string;
  username: string;
  email: string;
  role: string | null;
  createdAt: string;
  subscriptions: number;
  followers: number;
}
