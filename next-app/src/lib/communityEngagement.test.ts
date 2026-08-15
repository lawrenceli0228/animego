import { describe, expect, test } from "bun:test";
import {
  communityDiscussionTarget,
  engagementSessionKey,
  engagementRequestBody,
} from "./communityEngagement";

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

  test("uses separate daily session keys for exposure and first open", () => {
    expect(engagementSessionKey("impression", "2026-08-15")).toBe(
      "animego:community:hot-discussions:impression:2026-08-15",
    );
    expect(engagementSessionKey("open", "2026-08-15")).toBe(
      "animego:community:hot-discussions:open:2026-08-15",
    );
  });
});
