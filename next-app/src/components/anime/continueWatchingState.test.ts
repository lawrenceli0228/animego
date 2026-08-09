import { describe, expect, test } from "bun:test";
import type { SubStatus } from "@/lib/subscriptionBus";
import {
  currentSeasonHref,
  isWatchingArrival,
  nextWatchingIds,
  resolveWatchingView,
} from "./continueWatchingState";

const change = (status: SubStatus | null) => ({
  anilistId: 20661,
  sub: status === null ? null : { status, currentEpisode: 0, score: null },
});

// Dates are built with the local-time constructor, not ISO strings: the helper
// reads getMonth()/getFullYear() (local), so `new Date("2026-04-01T00:00:00Z")`
// would land in March — and fail the suite — on any machine west of UTC.
const localDate = (year: number, monthIndex: number) =>
  new Date(year, monthIndex, 15);

describe("resolveWatchingView", () => {
  test("anonymous visitor gets the login stub, stale rows or not", () => {
    expect(resolveWatchingView(true, 0)).toBe("logged-out");
    expect(resolveWatchingView(true, 5)).toBe("logged-out");
  });

  test("logged in with rows renders the grid", () => {
    expect(resolveWatchingView(false, 1)).toBe("grid");
    expect(resolveWatchingView(false, 40)).toBe("grid");
  });

  test("logged in with zero rows renders the empty stub, never nothing", () => {
    // The regression this guards: this branch used to `return null`, so the
    // homepage lost a whole section the moment someone registered.
    expect(resolveWatchingView(false, 0)).toBe("empty");
  });

  test("registering never removes a section from the page", () => {
    // Anonymous and freshly-registered must both render *something*.
    expect(resolveWatchingView(true, 0)).not.toBe("grid");
    expect(resolveWatchingView(false, 0)).not.toBe("grid");
    expect(resolveWatchingView(true, 0)).not.toBe(resolveWatchingView(false, 0));
  });
});

describe("isWatchingArrival", () => {
  test("a quick-add from the grid above flips the section's copy", () => {
    // The failure this closes: `/` renders the empty stub from a server read,
    // the visitor presses + on a trending poster twelve pixels above it, the
    // card turns ✓ — and the paragraph underneath still says "you're not
    // tracking anything yet".
    expect(isWatchingArrival(change("watching"))).toBe(true);
  });

  test("statuses this section never displays leave the copy alone", () => {
    // The server asked for ?status=watching. A row marked completed or
    // dropped would not appear in the grid on the next load either, so
    // swapping to "here's your list" would just relocate the contradiction to
    // the next page view.
    expect(isWatchingArrival(change("completed"))).toBe(false);
    expect(isWatchingArrival(change("plan_to_watch"))).toBe(false);
    expect(isWatchingArrival(change("dropped"))).toBe(false);
  });

  test("a removal is not an arrival", () => {
    // sub: null is what a DELETE broadcasts. Nothing arrived.
    expect(isWatchingArrival(change(null))).toBe(false);
  });
});

describe("nextWatchingIds", () => {
  const empty: ReadonlySet<number> = new Set<number>();

  test("an add fills the set, so the section stops claiming it is empty", () => {
    expect([...nextWatchingIds(empty, change("watching"))]).toEqual([20661]);
  });

  test("undoing the add empties it again", () => {
    // The quick-add toast offers Undo. Latching on the first add would leave
    // the homepage reading "added to Watching" for a row the user just took
    // back — the same lie as the bug this whole component fixes, inverted.
    const afterAdd = nextWatchingIds(empty, change("watching"));
    expect(nextWatchingIds(afterAdd, change(null)).size).toBe(0);
  });

  test("moving a row out of `watching` also empties it", () => {
    // The section stands in for ?status=watching. A row marked completed is
    // not in that answer, so the copy must go back to the empty state rather
    // than promise a grid that will render nothing.
    const afterAdd = nextWatchingIds(empty, change("watching"));
    expect(nextWatchingIds(afterAdd, change("completed")).size).toBe(0);
  });

  test("counts rows, so undoing one of two keeps the section filled", () => {
    const one = nextWatchingIds(empty, change("watching"));
    const two = nextWatchingIds(one, { ...change("watching"), anilistId: 21 });
    expect(two.size).toBe(2);
    expect(nextWatchingIds(two, change(null)).size).toBe(1);
  });

  test("a no-op event returns the same reference", () => {
    // Every provider write echoes back onto this bus. A fresh Set per echo
    // would re-render the section for nothing.
    const one = nextWatchingIds(empty, change("watching"));
    expect(nextWatchingIds(one, change("watching"))).toBe(one);
    expect(nextWatchingIds(empty, change(null))).toBe(empty);
  });
});

describe("currentSeasonHref", () => {
  test("maps each calendar quarter to its season slug", () => {
    expect(currentSeasonHref(localDate(2026, 0))).toBe("/seasonal/winter/2026");
    expect(currentSeasonHref(localDate(2026, 3))).toBe("/seasonal/spring/2026");
    expect(currentSeasonHref(localDate(2026, 7))).toBe("/seasonal/summer/2026");
    expect(currentSeasonHref(localDate(2026, 11))).toBe("/seasonal/fall/2026");
  });

  test("quarter boundaries land on the right side", () => {
    expect(currentSeasonHref(localDate(2026, 2))).toContain("winter"); // Mar
    expect(currentSeasonHref(localDate(2026, 5))).toContain("spring"); // Jun
    expect(currentSeasonHref(localDate(2026, 8))).toContain("summer"); // Sep
    expect(currentSeasonHref(localDate(2026, 9))).toContain("fall"); //   Oct
  });

  test("every month emits a slug /seasonal/[season]/[year] will accept", () => {
    // The route notFound()s on anything outside this set, so an off-by-one in
    // the quarter maths would ship a homepage CTA pointing at a 404.
    const valid = new Set(["winter", "spring", "summer", "fall"]);
    for (let month = 0; month < 12; month += 1) {
      const [, , slug, year] = currentSeasonHref(localDate(2026, month)).split("/");
      expect(valid.has(slug)).toBe(true);
      expect(year).toBe("2026");
    }
  });

  test("follows the clock instead of pinning a season", () => {
    // sitemap.ts hardcoded spring/2026 and was still pointing crawlers there
    // in August; this CTA must not repeat that.
    expect(currentSeasonHref(localDate(2026, 7))).not.toBe(
      currentSeasonHref(localDate(2027, 1)),
    );
  });
});
