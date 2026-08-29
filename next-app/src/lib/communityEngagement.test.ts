import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  communityDiscussionTarget,
  engagementSessionKey,
  engagementRequestBody,
  trackHotDiscussionOpen,
  trackHotDiscussionsImpressionOnce,
  trackWelcomeCardImpressionOnce,
  trackWelcomeCardOpen,
} from "./communityEngagement";

// bun:test runs in node — no window, no sessionStorage, no fetch worth
// hitting. The tracking half of this suite installs all three, following
// pendingSubscribe.test.ts, and restores them afterwards so nothing leaks into
// a sibling file sharing the process.

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

interface SentEvent {
  eventType: string;
  source: string;
  anilistId?: number;
  episode?: number;
}

const hadWindow = "window" in globalThis;
const originalWindow = (globalThis as { window?: unknown }).window;
const originalFetch = globalThis.fetch;

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function installWindow(store: StorageLike | (() => never)): void {
  const win: Record<string, unknown> = {};
  if (typeof store === "function") {
    // Property ACCESS throws — Safari private mode / "block all cookies".
    Object.defineProperty(win, "sessionStorage", { get: store });
  } else {
    win.sessionStorage = store;
  }
  (globalThis as { window?: unknown }).window = win;
}

/** Captures every event the module would have POSTed, in order. */
function installFetch(): SentEvent[] {
  const sent: SentEvent[] = [];
  globalThis.fetch = ((url: string, init: { body: string }) => {
    expect(url).toBe("/api/community/engagement");
    sent.push(JSON.parse(init.body) as SentEvent);
    return Promise.resolve(new Response(null, { status: 202 }));
  }) as typeof fetch;
  return sent;
}

afterEach(() => {
  if (hadWindow) (globalThis as { window?: unknown }).window = originalWindow;
  else delete (globalThis as { window?: unknown }).window;
  globalThis.fetch = originalFetch;
});

describe("community engagement helpers", () => {
  test("builds a stable deep link to the latest comment", () => {
    expect(communityDiscussionTarget(154587, 8, "abc-123")).toBe(
      "/anime/154587#episode-8-comment-abc-123",
    );
    expect(communityDiscussionTarget(0, 8, "abc")).toBe("");
    expect(communityDiscussionTarget(1, 0, "abc")).toBe("");
    expect(communityDiscussionTarget(1, 1, " ")).toBe("");
  });

  test("serializes only the allowlisted aggregate event shape", () => {
    expect(
      engagementRequestBody({
        eventType: "discussion_open",
        source: "home",
        anilistId: 154587,
        episode: 8,
      }),
    ).toBe(
      '{"eventType":"discussion_open","source":"home","anilistId":154587,"episode":8}',
    );
  });

  test("serializes an untargeted event with no anime fields at all", () => {
    // community_engagement_target_chk requires anilist_id = 0 AND episode = 0
    // for this event.  Omitting the keys is how the Go handler's zero values
    // end up satisfying it; sending null or undefined would decode to 0 too,
    // but sending a number would be rejected at the database edge.
    expect(
      engagementRequestBody({
        eventType: "welcome_card_open",
        source: "home",
      }),
    ).toBe('{"eventType":"welcome_card_open","source":"home"}');
  });

  test("uses separate daily session keys for exposure and first open", () => {
    expect(engagementSessionKey("impression", "2026-08-15")).toBe(
      "animego:community:hot-discussions:impression:2026-08-15",
    );
    expect(engagementSessionKey("open", "2026-08-15")).toBe(
      "animego:community:hot-discussions:open:2026-08-15",
    );
  });

  test("the welcome card's keys are distinct from the rail's", () => {
    // Sharing a key would make the first welcome-card click suppress the
    // first discussion click of the day, which is a silent undercount rather
    // than a visible failure.
    const keys = (["impression", "open", "welcome-impression", "welcome-open"] as const).map(
      (kind) => engagementSessionKey(kind, "2026-08-15"),
    );
    expect(new Set(keys).size).toBe(4);
    expect(keys[2]).toBe(
      "animego:community:hot-discussions:welcome-impression:2026-08-15",
    );
    expect(keys[3]).toBe(
      "animego:community:hot-discussions:welcome-open:2026-08-15",
    );
  });
});

describe("welcome card exposure is not gated on the rail having items", () => {
  let sent: SentEvent[];

  beforeEach(() => {
    installWindow(memoryStorage());
    sent = installFetch();
  });

  test("an empty rail records the welcome card but not the rail", () => {
    // This is the entire reason welcome_card_impression exists as its own
    // event.  The card renders outside the `items.length` conditional, so on
    // an empty rail it is on screen and clickable while the rail's own
    // impression is deliberately suppressed.  Reusing that count as the
    // card's denominator would divide by a number that omits exactly these
    // renders and overstate the click rate.
    expect(trackHotDiscussionsImpressionOnce(0)).toBe(false);
    expect(trackWelcomeCardImpressionOnce()).toBe(true);

    expect(sent).toEqual([{ eventType: "welcome_card_impression", source: "home" }]);
  });

  test("a populated rail records both, as two separate events", () => {
    expect(trackHotDiscussionsImpressionOnce(3)).toBe(true);
    expect(trackWelcomeCardImpressionOnce()).toBe(true);

    expect(sent.map((e) => e.eventType)).toEqual([
      "hot_discussions_impression",
      "welcome_card_impression",
    ]);
  });

  test("a welcome click carries no anime target", () => {
    // The Go allowlist and community_engagement_target_chk both require this.
    trackWelcomeCardOpen();
    expect(sent).toEqual([{ eventType: "welcome_card_open", source: "home" }]);
  });
});

describe("per-kind daily dedupe", () => {
  let sent: SentEvent[];

  beforeEach(() => {
    installWindow(memoryStorage());
    sent = installFetch();
  });

  test("each kind is claimed once per day, independently of the others", () => {
    trackWelcomeCardImpressionOnce();
    trackWelcomeCardImpressionOnce();
    trackWelcomeCardOpen();
    trackWelcomeCardOpen();
    trackHotDiscussionsImpressionOnce(2);
    trackHotDiscussionsImpressionOnce(2);
    trackHotDiscussionOpen(154587, 8);
    trackHotDiscussionOpen(999, 1);

    // Four events, one per kind — not eight, and not fewer because one kind
    // consumed another's key.
    expect(sent.map((e) => e.eventType)).toEqual([
      "welcome_card_impression",
      "welcome_card_open",
      "hot_discussions_impression",
      "discussion_open",
    ]);
  });

  test("a second call returns false rather than throwing", () => {
    expect(trackWelcomeCardImpressionOnce()).toBe(true);
    expect(trackWelcomeCardImpressionOnce()).toBe(false);
  });
});

describe("hostile or absent environment", () => {
  test("blocked storage counts a repeat rather than dropping the event", () => {
    // Safari private mode throws on the property access itself.  A noisy
    // numerator is recoverable; a missing one is not.
    installWindow(() => {
      throw new Error("SecurityError: storage blocked");
    });
    const sent = installFetch();

    expect(() => trackWelcomeCardImpressionOnce()).not.toThrow();
    expect(() => trackWelcomeCardOpen()).not.toThrow();
    expect(sent.map((e) => e.eventType)).toEqual([
      "welcome_card_impression",
      "welcome_card_open",
    ]);
  });

  test("a throwing setItem still sends", () => {
    installWindow({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    });
    const sent = installFetch();

    trackWelcomeCardOpen();
    expect(sent).toHaveLength(1);
  });

  test("no window at all (SSR import) sends nothing and does not throw", () => {
    delete (globalThis as { window?: unknown }).window;
    const sent = installFetch();

    expect(trackWelcomeCardImpressionOnce()).toBe(false);
    expect(() => trackWelcomeCardOpen()).not.toThrow();
    expect(sent).toEqual([]);
  });
});
