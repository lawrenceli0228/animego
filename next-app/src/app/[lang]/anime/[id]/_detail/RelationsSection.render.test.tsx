import { describe, expect, test } from "bun:test";

import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import { LanguageProvider } from "@/lib/lang-client";
import { renderAsNextDev } from "@/lib/test-utils/nextImage";
import type { DetailRelation } from "@/lib/types";
import en from "@/locales/en";
import zh from "@/locales/zh";
import zhHant from "@/locales/zh-Hant";
import RelationsSection from "./RelationsSection";

// 关联作品 as the server sends it: where each card leads and what its badge
// says. renderToStaticMarkup through renderAsNextDev, as DetailHero's test:
// FadeImage is next/image, which checks each cover against the app's
// remotePatterns. The dictionaries are imported directly for the reason
// DetailHero.render.test.tsx gives.

function relation(anilistId: number, relationType: string, format: string | null, title: string): DetailRelation {
  return {
    anilistId,
    relationType,
    title,
    titleChinese: null,
    coverImageUrl: `https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx${anilistId}.jpg`,
    format,
  };
}

// 葬送的芙莉莲 第二季's relations, plus a novel, a one-shot and a row whose
// format AniList did not send.
const RELATIONS: DetailRelation[] = [
  relation(118586, "ADAPTATION", "MANGA", "Sousou no Frieren"),
  relation(209939, "SEQUEL", "TV", "Sousou no Frieren 3rd Season"),
  relation(154587, "PREQUEL", "TV", "Sousou no Frieren"),
  relation(206425, "SIDE_STORY", "ONA", "Sousou no Frieren: ●● no Mahou Part 3"),
  relation(126268, "ALTERNATIVE", "NOVEL", "Gimai Seikatsu"),
  relation(198506, "OTHER", "ONE_SHOT", "Kurotaki Buchou no Inokori Shidou"),
  relation(40001, "OTHER", null, "Unknown Format"),
];

type Card = { href: string; attrs: string; labels: string[]; title: string };

// Read by structure, not class: CSS module classes are undefined under bun
// test. The labels are the spans inside the cover frame, in order: the
// relation, then on a print work what it is.
function cards(html: string): Card[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, inner]) => {
    const frame = inner.slice(0, inner.indexOf("</div>"));
    return {
      href: /href="([^"]+)"/.exec(attrs)?.[1] ?? "",
      attrs,
      labels: [...frame.matchAll(/<span[^>]*>([^<]*)(?:<svg[\s\S]*?<\/svg>)?<\/span>/g)].map((m) => m[1]),
      title: (/<p[^>]*>([\s\S]*?)<\/p>/.exec(inner)?.[1] ?? "").replace(/<[^>]+>/g, ""),
    };
  });
}

function render(lang: Lang, dict: Dict): Card[] {
  return cards(
    renderAsNextDev(
      <LanguageProvider lang={lang}>
        <RelationsSection relations={RELATIONS} lang={lang} dict={dict} />
      </LanguageProvider>,
    ),
  );
}

describe("RelationsSection", () => {
  test("anime open their page here; print works open AniList's", () => {
    expect(render("zh", zh).map((c) => [c.href, c.labels])).toEqual([
      ["/anime/154587", ["前传"]],
      ["/anime/209939", ["续集"]],
      ["/anime/206425", ["番外"]],
      ["https://anilist.co/manga/118586", ["改编", "漫画"]],
      ["https://anilist.co/manga/126268", ["替代版", "小说"]],
      ["https://anilist.co/manga/198506", ["其他", "单篇"]],
      ["/anime/40001", ["其他"]],
    ]);
  });

  test("English: relation and format are two labels, each one word", () => {
    // en is cast for the reason lib/i18n.ts gives at DICTS.
    const print = render("en", en as unknown as Dict).filter((c) => c.href.startsWith("https://anilist.co/"));
    expect(print.map((c) => c.labels)).toEqual([
      ["Adaptation", "Manga"],
      ["Alternative", "Novel"],
      ["Other", "One Shot"],
    ]);
    expect(print[0].attrs).toContain('title="View on AniList"');
  });

  test("no card links a print work to /anime/", () => {
    const hrefs = render("zh", zh).map((c) => c.href);
    for (const id of [118586, 126268, 198506]) {
      expect(hrefs.some((h) => h.includes(`/anime/${id}`))).toBe(false);
    }
  });

  test("a print card opens a new tab, says where it goes, and draws the arrow", () => {
    const html = renderAsNextDev(
      <LanguageProvider lang="zh">
        <RelationsSection relations={RELATIONS} lang="zh" dict={zh} />
      </LanguageProvider>,
    );
    const print = cards(html).find((c) => c.href === "https://anilist.co/manga/118586");
    expect(print).toBeDefined();
    expect(print!.attrs).toContain('target="_blank"');
    expect(print!.attrs).toContain('rel="noopener noreferrer"');
    expect(print!.attrs).toContain('title="在 AniList 查看"');
    expect(print!.title).toBe("Sousou no Frieren");

    // The arrow rides on the format label, not on the relation.
    const printBlock = /<a\b[^>]*href="https:\/\/anilist\.co\/manga\/118586"[^>]*>([\s\S]*?)<\/a>/.exec(html)![1];
    expect(printBlock).toMatch(/<span[^>]*>漫画<svg[^>]*aria-hidden="true"/);
    expect(printBlock).toMatch(/<span[^>]*>改编<\/span>/);
    expect(printBlock.match(/<svg/g)).toHaveLength(1);

    const animeBlock = /<a\b[^>]*href="\/anime\/154587"[^>]*>([\s\S]*?)<\/a>/.exec(html)![1];
    expect(animeBlock).not.toContain("<svg");
    const anime = cards(html).find((c) => c.href === "/anime/154587")!;
    expect(anime.attrs).not.toContain("target=");
  });

  test("Traditional Chinese: the labels follow, AniList's address does not", () => {
    const hant = render("zh-Hant", zhHant);
    const print = hant.find((c) => c.href.startsWith("https://anilist.co/"));
    expect(print?.href).toBe("https://anilist.co/manga/118586");
    expect(print?.labels).toEqual(["改編", "漫畫"]);
    expect(print?.attrs).toContain('title="在 AniList 檢視"');
  });

  test("no relations, no section", () => {
    const html = renderAsNextDev(<RelationsSection relations={[]} lang="zh" dict={zh} />);
    expect(html).toBe("");
  });
});
