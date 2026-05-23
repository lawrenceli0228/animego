import type {
  ApiEnvelope,
  ApiErrorBody,
  ApiPagedEnvelope,
} from "./types";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Base URL for go-api requests.
 *
 * Server-side (RSC, server actions, route handlers):
 *   Next dev rewrites only fire for browser requests; a server-side
 *   `fetch('/api/foo')` has no base URL. Read from env, fall back to
 *   the dev port so a fresh clone works without configuration.
 *
 * Client-side (component, useEffect, event handler):
 *   Return '' so `fetch('/api/foo')` is same-origin. Dev next rewrites
 *   the path to :8080; prod nginx proxies to the go-api container.
 */
export function getApiBase(): string {
  if (typeof window !== "undefined") return "";
  return process.env.GO_API_INTERNAL_URL || "http://localhost:8080";
}

interface FetchOptions {
  /** Next 16 fetch cache mode. Defaults to 'no-store' (dynamic). */
  cache?: RequestCache;
  /** Next 16 ISR revalidate window in seconds. */
  revalidate?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

interface NextFetchInit extends RequestInit {
  next?: {
    revalidate?: number;
    tags?: string[];
  };
}

async function fetchEnvelope(
  path: string,
  opts: FetchOptions,
): Promise<unknown> {
  const url = `${getApiBase()}${path}`;

  const init: NextFetchInit = {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: opts.signal,
  };
  if (typeof opts.revalidate === "number") {
    init.next = { revalidate: opts.revalidate };
  } else {
    init.cache = opts.cache ?? "no-store";
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError("NETWORK_ERROR", "fetch failed", 0, err);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ApiError(
      "INVALID_JSON",
      `non-JSON response (status ${res.status})`,
      res.status,
      err,
    );
  }

  if (!res.ok || (body && typeof body === "object" && "error" in body)) {
    const errBody = (body as ApiErrorBody | undefined)?.error;
    throw new ApiError(
      errBody?.code || "SERVER_ERROR",
      errBody?.message || `HTTP ${res.status}`,
      res.status,
    );
  }

  return body;
}

/**
 * GET request that unwraps the `{data: T}` envelope.
 *
 * @example
 *   const trending = await apiGet<TrendingItem[]>('/api/anime/trending?limit=10');
 *   const detail = await apiGet<AnimeDetail>('/api/anime/154587');
 */
export async function apiGet<T>(
  path: string,
  opts: FetchOptions = {},
): Promise<T> {
  const body = await fetchEnvelope(path, opts);
  const env = body as ApiEnvelope<T>;
  return env.data;
}

/**
 * GET request for paged endpoints, returns the full envelope including
 * `total`, `page`, `hasMore`, `nextPage`.
 *
 * @example
 *   const page = await apiGetPaged<SeasonalAnime>('/api/anime/seasonal?page=1');
 *   if (page.hasMore) loadPage(page.nextPage!);
 */
export async function apiGetPaged<T>(
  path: string,
  opts: FetchOptions = {},
): Promise<ApiPagedEnvelope<T>> {
  const body = await fetchEnvelope(path, opts);
  return body as ApiPagedEnvelope<T>;
}
