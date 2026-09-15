// The one fetch every hub page makes, and the page-number parsing that
// goes with it.

import { apiGetEnvelope } from "@/lib/api";
import type { SeasonalAnime } from "@/lib/types";
import { HUB_PAGE_SIZE, type HubPagination } from "@/components/hubs/HubListing";

export const HUB_REVALIDATE = 300;

const EMPTY: SeasonalAnime[] = [];

/** The Go envelope: the seasonal one, with the same pagination block. */
interface BrowseEnvelope {
  data: SeasonalAnime[];
  pagination?: { page: number; perPage: number; total: number; totalPages: number };
}

/** ?page=N → a positive integer; anything else is page 1. */
export function parseHubPage(raw: string | string[] | undefined): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export async function fetchHub(
  key: "genre" | "studio" | "year",
  value: string,
  page: number,
): Promise<{ items: SeasonalAnime[]; pagination: HubPagination }> {
  const qs = new URLSearchParams({ [key]: value, page: String(page), perPage: String(HUB_PAGE_SIZE) });
  try {
    const env = await apiGetEnvelope<BrowseEnvelope>(`/api/anime/browse?${qs}`, { revalidate: HUB_REVALIDATE });
    const p = env.pagination;
    return {
      items: env.data ?? EMPTY,
      pagination: { page: p?.page ?? page, totalPages: p?.totalPages ?? 0, total: p?.total ?? 0 },
    };
  } catch {
    // Same contract as the seasonal page: an empty grid over a 500.
    return { items: EMPTY, pagination: { page, totalPages: 0, total: 0 } };
  }
}
