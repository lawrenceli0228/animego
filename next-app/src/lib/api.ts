import type {
  ApiEnvelope,
  ApiErrorBody,
  ApiPagedEnvelope,
} from "./types";

// `next/headers` only resolves inside a real RSC / route-handler /
// server-action call stack. We import it lazily inside buildHeaders()
// to keep client bundles free of the server-only module reference and
// to make the call survive contexts where `cookies()` would throw
// (e.g. static prerender, middleware-level fetches).
type CookieJar = { toString(): string };
type CookiesFn = () => Promise<CookieJar> | CookieJar;

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

// P8.1 cookie dual-track:
//
// When this module runs in an RSC / server-component / route-handler
// context, forward the browser's Cookie header so the upstream Express
// can authenticate via the `session` cookie (see
// server/middleware/auth.middleware.js readToken). Without this, every
// RSC fetch is anonymous and any user-scoped data path silently 401s.
//
// Skipped silently if cookies() throws (no RSC context, e.g. static
// prerender) — the request just goes out anonymously, same as before.
async function buildHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (typeof window !== "undefined") return headers;
  try {
    const mod = (await import("next/headers")) as { cookies: CookiesFn };
    const jar = await mod.cookies();
    const cookieStr = jar.toString();
    if (cookieStr) headers.Cookie = cookieStr;
  } catch {
    /* no RSC context — forward nothing */
  }
  return headers;
}

type MutationMethod = "POST" | "PATCH" | "DELETE" | "PUT";

interface MutationOptions {
  /** Request body — will be JSON.stringified. Skip for endpoints
   *  with no body. */
  body?: unknown;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

async function fetchEnvelope(
  path: string,
  opts: FetchOptions,
): Promise<unknown> {
  const url = `${getApiBase()}${path}`;

  const init: NextFetchInit = {
    method: "GET",
    headers: await buildHeaders(),
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
/**
 * Non-GET request that unwraps the `{data: T}` envelope.
 *
 * Used by Server Actions for admin mutations (PATCH /enrichment/:id,
 * POST /users, DELETE /users/:id, etc). Forwards the same Cookie
 * header buildHeaders attaches to GETs, so server-action callers
 * authenticate as the requesting user without extra wiring.
 *
 * @example
 *   await apiMutate<{ anilistId: number; reset: true }>(
 *     "/api/admin/enrichment/154587/reset",
 *     "POST",
 *   );
 *   const created = await apiMutate<AdminUser>(
 *     "/api/admin/users", "POST",
 *     { body: { username, email, password } },
 *   );
 */
export async function apiMutate<T>(
  path: string,
  method: MutationMethod,
  opts: MutationOptions = {},
): Promise<T> {
  const url = `${getApiBase()}${path}`;
  const headers = await buildHeaders();
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const init: RequestInit = {
    method,
    headers,
    signal: opts.signal,
    cache: "no-store",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  };

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError("NETWORK_ERROR", "fetch failed", 0, err);
  }

  // 204 No Content or empty body — return undefined cast to T (callers
  // for delete-style endpoints can ignore the return).
  if (res.status === 204) return undefined as T;

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

  const env = body as ApiEnvelope<T>;
  return env.data;
}

export async function apiGetPaged<T>(
  path: string,
  opts: FetchOptions = {},
): Promise<ApiPagedEnvelope<T>> {
  const body = await fetchEnvelope(path, opts);
  return body as ApiPagedEnvelope<T>;
}

/**
 * GET request that returns the raw envelope body without unwrapping
 * `data`. Use this for endpoints whose JSON shape is a custom envelope
 * — e.g. `/api/anime/:id/watchers` returns `{data, total}` where
 * `total` lives at the top level rather than nested under `data`.
 *
 * Errors map to ApiError just like apiGet/apiGetPaged, so callers can
 * handle 401/404 via `err.status`.
 *
 * @example
 *   const env = await apiGetEnvelope<WatchersResponse>(
 *     `/api/anime/${anilistId}/watchers?limit=8`
 *   );
 *   const { data, total } = env;
 */
export async function apiGetEnvelope<T>(
  path: string,
  opts: FetchOptions = {},
): Promise<T> {
  const body = await fetchEnvelope(path, opts);
  return body as T;
}
