import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { HueCard } from "@/lib/home/viewModels";
import HueBrowser, { type HueFamilyView } from "./HueBrowser";

// renderToStaticMarkup, as in TodayRail.render.test.tsx: no jsdom.
//
// What is pinned: a family shows every show in it — the pill said "15 部" and
// the panel used to hold 10, of which a wide screen drew 6, with no way to the
// rest. Each family is now a sideways rail with a labelled slider, and the
// rail ends by offering the next family. (The CSS half — no rule may hide a
// card — is TodayRail.css.test.ts, which scans this section's stylesheet too.)

const card = (id: number, hue: number): HueCard => ({
  id,
  href: `/anime/${id}`,
  title: `测试番 ${id}`,
  cover: null,
  hue,
  score: "7.5",
  meta: "TV · 连载中",
});

const family = (key: HueFamilyView["key"], label: string, hue: number, n: number, base: number): HueFamilyView => {
  const items = Array.from({ length: n }, (_, i) => card(base + i, hue));
  return { key, label, hue, count: items.length, items };
};

const BLUE = family("blue", "蓝调", 245, 15, 1000);
const PURPLE = family("purple", "紫调", 305, 3, 2000);
const RED = family("red", "红调", 20, 8, 3000);

const COPY = {
  scroll: "横向滚动{{family}}",
  scrollValue: "第 {{from}}–{{to}} 部，共 {{n}} 部",
  endTitle: "{{family}}就这些",
  endNext: "下一组 · {{family}} {{n}} 部",
  endLink: "看{{family}}",
};

function render(families: HueFamilyView[], defaultKey = families[0].key): string {
  return renderToStaticMarkup(
    <HueBrowser
      title="按色调逛"
      note="本季 26 部 · 按封面主色分组"
      groupLabel="按色调筛选"
      countTemplate="{{n}} 部"
      families={families}
      defaultKey={defaultKey}
      railCopy={COPY}
    />,
  );
}

/** One family's panel: from its rail's id to the next panel (or the end). */
function panelOf(html: string, key: string): string {
  const at = html.indexOf(`id="home-hue-${key}"`);
  if (at < 0) return "";
  const rest = html.slice(at + 1);
  const next = rest.search(/id="home-hue-(?:red|orange|yellow|green|cyan|blue|purple)"/);
  return next < 0 ? rest : rest.slice(0, next);
}

const cardsIn = (panel: string) => panel.match(/href="\/anime\/\d+"/g) ?? [];

describe("HueBrowser", () => {
  test("a family's panel holds every show in it, not the first ten", () => {
    const html = render([RED, BLUE, PURPLE], "blue");
    expect(cardsIn(panelOf(html, "blue"))).toHaveLength(15);
    expect(cardsIn(panelOf(html, "red"))).toHaveLength(8);
    expect(cardsIn(panelOf(html, "purple"))).toHaveLength(3);
  });

  test("the pill's number is the number of cards behind it", () => {
    const html = render([RED, BLUE, PURPLE], "blue");
    expect(html).toMatch(/蓝调<span[^>]*>15 部<\/span>/);
    expect(html).toMatch(/红调<span[^>]*>8 部<\/span>/);
  });

  test("each rail is moved by a slider named after its family", () => {
    const html = render([RED, BLUE, PURPLE], "blue");
    for (const [key, label] of [["red", "红调"], ["blue", "蓝调"], ["purple", "紫调"]]) {
      expect(html).toMatch(new RegExp(`<input[^>]*type="range"[^>]*aria-label="横向滚动${label}"[^>]*aria-controls="home-hue-${key}"`));
    }
  });

  test("each rail ends by offering the next family, the last wrapping to the first", () => {
    const html = render([RED, BLUE, PURPLE], "blue");
    const blue = panelOf(html, "blue");
    expect(blue).toContain("蓝调就这些");
    expect(blue).toContain("下一组 · 紫调 3 部");
    expect(blue).toContain("看紫调");
    const purple = panelOf(html, "purple");
    expect(purple).toContain("紫调就这些");
    expect(purple).toContain("下一组 · 红调 8 部");
  });

  test("a lone family has nowhere to send the reader: no end panel", () => {
    const html = render([BLUE]);
    expect(cardsIn(panelOf(html, "blue"))).toHaveLength(15);
    expect(html).not.toContain("就这些");
  });

  test("only the chosen family is exposed; the others are inert", () => {
    const html = render([RED, BLUE, PURPLE], "blue");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/蓝调<span[^>]*>15 部<\/span>/);
    const exposed = html.match(/<div[^>]*data-active="true"[^>]*>/g) ?? [];
    expect(exposed.filter((tag) => !/aria-hidden="true"/.test(tag) && !/inert/.test(tag))).toHaveLength(1);
  });

  test("renders nothing when no show has a colour", () => {
    expect(render([] as HueFamilyView[], "blue" as never)).toBe("");
  });
});
