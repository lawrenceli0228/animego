import { describe, expect, test } from "bun:test";

import { parseAnilistMarkdown, type InlineNode, type Paragraph } from "./anilistMarkdown";

/** A paragraph as a compact string: [spoiler#id:…], *strong*, _em_, / for a line break. */
function show(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return n.value;
        case "br":
          return "/";
        case "strong":
          return `*${show(n.children)}*`;
        case "em":
          return `_${show(n.children)}_`;
        case "spoiler":
          return `[spoiler#${n.id}${n.continued ? "+" : ""}:${show(n.children)}]`;
      }
    })
    .join("");
}

const paragraphs = (md: string | null): string[] => parseAnilistMarkdown(md).map((p: Paragraph) => show(p.inlines));

describe("parseAnilistMarkdown", () => {
  test("nothing in, nothing out", () => {
    expect(paragraphs(null)).toEqual([]);
    expect(paragraphs("   \n\n ")).toEqual([]);
  });

  test("links keep their text and lose their target", () => {
    expect(
      paragraphs(
        "Stark fights alongside [Frieren](https://anilist.co/character/176754/Frieren) and [Fern](https://anilist.co/character/183965/Fern).",
      ),
    ).toEqual(["Stark fights alongside Frieren and Fern."]);
  });

  test("blank lines are paragraphs, single newlines are line breaks", () => {
    expect(paragraphs("__Height:__ 175 cm\n__Occupation:__ Sorcerer\n\nMegumi is a first-year.")).toEqual([
      "*Height:* 175 cm/*Occupation:* Sorcerer",
      "Megumi is a first-year.",
    ]);
  });

  test("emphasis in both spellings", () => {
    expect(paragraphs("**bold** and _italic_ and *also italic*")).toEqual(["*bold* and _italic_ and _also italic_"]);
    // An underscore inside a word is not emphasis.
    expect(paragraphs("snake_case_name stays")).toEqual(["snake_case_name stays"]);
  });

  test("an inline spoiler is a node, never the raw markers", () => {
    const md = "Übel is a third-class mage. ~!Becomes a first-class mage after the examination.!~";
    expect(paragraphs(md)).toEqual([
      "Übel is a third-class mage. [spoiler#0:Becomes a first-class mage after the examination.]",
    ]);
    expect(JSON.stringify(parseAnilistMarkdown(md))).not.toContain("~!");
  });

  test("a spoiler across paragraphs is one spoiler, continued", () => {
    const md = "Aura serves the Demon King.\n\n~!She is killed by [Frieren](https://anilist.co/character/176754).\n\nThe end.!~ After.";
    expect(paragraphs(md)).toEqual([
      "Aura serves the Demon King.",
      "[spoiler#0:She is killed by Frieren.]",
      "[spoiler#0+:The end.] After.",
    ]);
  });

  test("a spoiler that opens on blank space still has its first piece where the text starts", () => {
    expect(paragraphs("Intro. ~!  \n\nthe reveal!~")).toEqual(["Intro.", "[spoiler#0:the reveal]"]);
  });

  test("two spoilers get two ids", () => {
    expect(paragraphs("a ~!one!~ b ~!two!~")).toEqual(["a [spoiler#0:one] b [spoiler#1:two]"]);
  });

  test("an unclosed spoiler runs to the end rather than leaking", () => {
    expect(paragraphs("Safe. ~!Hidden to the end\n\nstill hidden")).toEqual([
      "Safe. [spoiler#0:Hidden to the end]",
      "[spoiler#0+:still hidden]",
    ]);
  });

  test("a stray closing marker is dropped", () => {
    expect(paragraphs("plain !~ text")).toEqual(["plain  text"]);
  });

  test("emphasis inside a spoiler stays inside it", () => {
    expect(paragraphs("~!__True name:__ Sein!~")).toEqual(["[spoiler#0:*True name:* Sein]"]);
  });

  test("html and AniList's own markup are reduced to text", () => {
    expect(paragraphs("Line one<br>Line two &amp; more <i>x</i>")).toEqual(["Line one/Line two & more x"]);
    expect(paragraphs("~~~centred~~~ and img220(https://x/y.png) gone")).toEqual(["centred and  gone"]);
    expect(paragraphs("![alt](https://x/y.png)Text")).toEqual(["Text"]);
    expect(paragraphs("# Heading\nbody")).toEqual(["Heading/body"]);
  });
});
