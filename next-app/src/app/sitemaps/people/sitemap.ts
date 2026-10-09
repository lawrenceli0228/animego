import type { MetadataRoute } from "next";
import { apiGet } from "@/lib/api";
import { PEOPLE_SITEMAP_SHARDS, personSitemapRows } from "@/lib/seo/peopleSitemap";
import type { SitemapEntity } from "@/lib/people/types";

// The indexed person pages, sharded: /sitemaps/people/sitemap/{0..3}.xml.
// The anime shards' route (app/sitemaps/anime/sitemap.ts) explains each piece
// of this: why it lives under /sitemaps/, why the shard list is a constant,
// why `id` is parsed, and why a failed fetch is an empty <urlset> rather than
// a 500.
//
// The fetch is the default (authenticated-path) apiGet, as there, and that is
// what keeps this route rendering per request. With auth:false nothing here
// reads the request, Next prerenders the shards at build time — when the API
// is not reachable — and serves those empty documents until the first
// revalidation after deploy.

const REVALIDATE_SECONDS = 3600;

export function generateSitemaps(): Array<{ id: number }> {
  return Array.from({ length: PEOPLE_SITEMAP_SHARDS }, (_, id) => ({ id }));
}

export default async function sitemap({ id }: { id: Promise<string> }): Promise<MetadataRoute.Sitemap> {
  const shard = Number(await id);
  if (!Number.isInteger(shard) || shard < 0 || shard >= PEOPLE_SITEMAP_SHARDS) return [];
  try {
    const items = await apiGet<SitemapEntity[]>(
      `/api/people/sitemap?shards=${PEOPLE_SITEMAP_SHARDS}&shard=${shard}`,
      { revalidate: REVALIDATE_SECONDS },
    );
    return personSitemapRows(items);
  } catch (err) {
    console.warn(`[sitemap] people shard ${shard} fetch failed:`, err);
    return [];
  }
}
