import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LanguageProvider } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import type { CommunitySummary } from "@/lib/community/types";
import { emptySummary } from "@/lib/community/types";
import ReviewEditor from "./ReviewEditor";
import SocialTab from "./SocialTab";
import { watchersSummary } from "./WatchersCard";
import zhSpa from "@/locales/zh-spa.js";

// renderToStaticMarkup, as the other render tests here: no DOM, no effects.
// What this sees is exactly the server render — the anonymous, cached HTML
// of /anime/[id]/social — before any per-reader fetch has run.

const RENDERED_AT = "2026-10-09T04:00:00Z";
const author = (username: string) => ({ username, avatarUrl: null, backdropCoverUrl: null });

function render(initial: CommunitySummary | null, lang: Lang = "zh"): string {
  return renderToStaticMarkup(
    <LanguageProvider lang={lang}>
      <SocialTab
        anilistId={154587}
        animeTitle="葬送的芙莉莲"
        coverUrl="https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/x.jpg"
        initial={initial}
        renderedAt={RENDERED_AT}
        lang={lang}
      />
    </LanguageProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const filled: CommunitySummary = {
  ...emptySummary(),
  reviews: {
    items: [
      {
        id: "r-open",
        anilistId: 154587,
        author: author("alice"),
        summary: "一部关于时间与告别的温柔之作",
        body: "**很好看**，节奏舒服。~!结局!~很动人。",
        bodyHidden: false,
        isSpoiler: false,
        isPrivate: false,
        helpfulCount: 2,
        viewerVoted: false,
        isOwn: false,
        createdAt: "2026-10-04T08:00:00Z",
        updatedAt: "2026-10-04T08:00:00Z",
      },
      {
        id: "r-spoiler",
        anilistId: 154587,
        author: author("bob"),
        summary: "结局让人意外的一部番",
        body: "",
        bodyHidden: true,
        isSpoiler: true,
        isPrivate: false,
        helpfulCount: 0,
        viewerVoted: false,
        isOwn: false,
        createdAt: "2025-08-30T00:00:00Z",
        updatedAt: "2025-08-30T00:00:00Z",
      },
    ],
    total: 2,
    page: 1,
    hasMore: false,
    nextPage: null,
  },
  threads: {
    items: [
      {
        id: "t1",
        anilistId: 154587,
        author: author("carol"),
        title: "第五集的回忆杀",
        excerpt: "大家怎么看辛美尔那段？",
        isSpoiler: false,
        replyCount: 3,
        isOwn: false,
        createdAt: "2026-10-05T00:00:00Z",
        lastActivityAt: "2026-10-06T00:00:00Z",
      },
    ],
    total: 1,
    page: 1,
    hasMore: true,
    nextPage: 2,
  },
  activity: {
    items: [
      {
        id: "e1",
        anilistId: 154587,
        author: author("alice"),
        status: "completed",
        likeCount: 1,
        viewerLiked: false,
        replyCount: 1,
        replies: [
          {
            id: "rep1",
            author: author("dave"),
            body: "我也看完了！",
            isSpoiler: false,
            parentId: null,
            replyToUsername: null,
            isOwn: false,
            createdAt: "2026-10-05T00:00:00Z",
          },
        ],
        isOwn: false,
        createdAt: "2026-10-04T08:00:00Z",
      },
    ],
    total: 1,
    page: 1,
    hasMore: false,
    nextPage: null,
  },
  watchers: {
    items: [
      { username: "alice", avatarUrl: null, backdropCoverUrl: null, status: "completed", currentEpisode: 28, since: "2026-10-04T08:00:00Z" },
      { username: "bob", avatarUrl: null, backdropCoverUrl: null, status: "completed", currentEpisode: 28, since: "2026-08-30T08:00:00Z" },
    ],
    total: 2,
    counts: { watching: 0, completed: 2, planToWatch: 0, dropped: 0 },
  },
  viewer: null,
};

describe("the 社区 tab, as the server renders it", () => {
  test("empty: the four headings and the drawn empty-state titles, nothing else", () => {
    const html = render(emptySummary());
    const body = text(html);
    for (const heading of ["评价", "讨论帖", "最近动态", "谁在追"]) expect(body).toContain(heading);
    expect(body).toContain("还没有人写评价");
    expect(body).toContain("还没有讨论帖");
    expect(body).toContain("还没有动态");
    expect(body).toContain("还没有人追这部番");
    // The canvas's grey explanatory sentences under the empty states are gone.
    expect(body).not.toContain("评价是完整的观后感");
    expect(body).not.toContain("就发个帖");
  });

  test("no score anywhere", () => {
    for (const html of [render(emptySummary()), render(filled)]) {
      const body = text(html);
      expect(body).not.toContain("评分");
      expect(body).not.toContain("★");
      expect(body).not.toMatch(/\/\s*10\b/);
      expect(body).not.toMatch(/\/\s*100\b/);
    }
  });

  test("a review: author, date, summary, body with its markup; spoilers inside stay closed", () => {
    const html = render(filled);
    const body = text(html);
    expect(body).toContain("一部关于时间与告别的温柔之作");
    expect(html).toContain("<strong>");
    expect(body).toContain("10 月 4 日");
    expect(body).toContain("有用 2");
    // The inline spoiler is a button whose text is hidden, not plain text.
    expect(html).toMatch(/<button[^>]*aria-label="剧透内容，点击显示"/);
  });

  test("a spoiler review is folded and its body is not in the page", () => {
    const body = text(render(filled));
    expect(body).toContain("结局让人意外的一部番");
    expect(body).toContain("含剧透，点击展开");
    expect(body).toContain("2025 年 8 月 30 日");
  });

  test("threads link to their own page, with the reply count", () => {
    const html = render(filled);
    expect(html).toContain('href="/anime/154587/social/threads/t1"');
    expect(text(html)).toContain("3 条回复");
    expect(text(html)).toContain("加载更多");
  });

  test("activity reads as the canvas does, with its replies", () => {
    const body = text(render(filled));
    expect(body).toContain("alice 看完了《葬送的芙莉莲》");
    expect(body).toContain("我也看完了！");
    expect(body).toContain("回复");
    expect(body).toContain("赞");
  });

  test("谁在追: the summary line, each person's status and since when", () => {
    const body = text(render(filled));
    expect(body).toContain("2 人 · 都已看完");
    expect(body).toContain("10 月 4 日看完");
    expect(body).toContain("追番，出现在这里");
  });

  test("signed out: writing goes to the write page, voting and liking go to login", () => {
    const html = render(filled);
    expect(html).toContain('href="/anime/154587/social/review"');
    expect(html).toMatch(/href="\/login"[^>]*>.*?有用/);
  });

  test("when the server could not read the community, the tab says it is loading", () => {
    const body = text(render(null));
    expect(body).toContain("加载中…");
    expect(body).not.toContain("还没有人写评价");
  });

  test("English and Traditional render through their own dictionaries", () => {
    expect(text(render(filled, "en"))).toContain("alice completed 葬送的芙莉莲");
    expect(text(render(filled, "zh-Hant"))).toContain("看完了《葬送的芙莉莲》");
    expect(text(render(emptySummary(), "zh-Hant"))).toContain("還沒有人寫評價");
  });
});

describe("the write page's editor", () => {
  test("counters, toolbar, and no score field", () => {
    const html = renderToStaticMarkup(
      <LanguageProvider lang="zh">
        <ReviewEditor summary="" body="" onSummary={() => {}} onBody={() => {}} showProblems={false} />
      </LanguageProvider>,
    );
    const body = text(html);
    expect(body).toContain("0 / 60 字，至少 10 字");
    expect(body).toContain("0 字，至少 300 字");
    for (const tool of ["剧透块", "插入链接", "编辑", "预览"]) expect(body).toContain(tool);
    expect(html).toContain('aria-label="加粗"');
    expect(html).toContain('aria-label="引用"');
    expect(body).not.toContain("评分");
    expect(html).not.toMatch(/type="(number|range)"/);
  });

  test("a short body after a first try is flagged", () => {
    const html = renderToStaticMarkup(
      <LanguageProvider lang="zh">
        <ReviewEditor summary="短" body="太短" onSummary={() => {}} onBody={() => {}} showProblems />
      </LanguageProvider>,
    );
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(2);
  });
});

test("watchersSummary: one status, several, none", () => {
  const t = (key: string) => {
    const parts = key.split(".");
    let v: unknown = zhSpa;
    for (const p of parts) v = (v as Record<string, unknown>)[p];
    return String(v);
  };
  const w = (counts: { watching: number; completed: number; planToWatch: number; dropped: number }) => ({
    items: [],
    total: counts.watching + counts.completed + counts.planToWatch + counts.dropped,
    counts,
  });
  expect(watchersSummary(w({ watching: 0, completed: 3, planToWatch: 0, dropped: 0 }), t)).toBe("3 人 · 都已看完");
  expect(watchersSummary(w({ watching: 1, completed: 2, planToWatch: 0, dropped: 0 }), t)).toBe("3 人 · 2 人看完 · 1 人在看");
  expect(watchersSummary(w({ watching: 0, completed: 0, planToWatch: 0, dropped: 0 }), t)).toBe("0 人");
});
