// Shape definitions for go-api admin endpoints. Mirrors
// docs/migration/P7-DESIGN.md §5 contract sheet. Keep these in sync
// with go-api/internal/admin/*.go response structs.

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
  };
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
