/**
 * Server-side GitHub repository telemetry for the /welcome "Open Source"
 * section. The fetch is hard-cached (6h ISR) and fails soft: any network
 * error or rate-limit degrades to null so the landing page never throws or
 * blocks on GitHub. Mirrors the safeTrending / safeDetail resilience in
 * welcome/page.tsx.
 *
 * Unauthenticated GitHub REST is 60 req/hr/IP; with the 6h revalidate window
 * that is a non-issue behind ISR + Cloudflare. Set GITHUB_TOKEN to raise the
 * ceiling to 5,000/hr (optional - absence degrades gracefully).
 */

const REPO = "lawrenceli0228/animego";
const GH_API = "https://api.github.com";
const REVALIDATE_SECONDS = 21600; // 6h - repo stats don't need to be fresher

/** Public repo telemetry shown in the Open Source section. */
export interface RepoStats {
  stars: number | null;
}

function ghHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "animego-welcome",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

interface RepoResponse {
  stargazers_count: number;
}

/**
 * Fetch the repo telemetry for the Open Source section. Always returns an
 * object; `stars` is null when the fetch failed, so the caller renders the
 * Star CTA either way. Never throws.
 */
export async function getRepoStats(): Promise<RepoStats> {
  try {
    const res = await fetch(`${GH_API}/repos/${REPO}`, {
      headers: ghHeaders(),
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) {
      if (res.status !== 404 && res.status !== 403) {
        console.warn(`[github] /repos/${REPO} -> ${res.status}`);
      }
      return { stars: null };
    }
    const repo = (await res.json()) as RepoResponse;
    return { stars: repo?.stargazers_count ?? null };
  } catch (err) {
    console.warn(`[github] /repos/${REPO} failed:`, err);
    return { stars: null };
  }
}
