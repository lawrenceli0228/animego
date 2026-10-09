import { describe, expect, test } from "bun:test";
import {
  linkSelection,
  parseInline,
  parseReview,
  plainText,
  quoteSelection,
  safeHref,
  wrapSelection,
} from "./reviewMarkup";

describe("parseInline", () => {
  test("plain text stays one node", () => {
    expect(parseInline("只是文字")).toEqual([{ kind: "text", text: "只是文字" }]);
  });

  test("bold, spoiler and link", () => {
    expect(parseInline("前**粗**中~!剧透!~后[链接](https://example.com/a)")).toEqual([
      { kind: "text", text: "前" },
      { kind: "bold", children: [{ kind: "text", text: "粗" }] },
      { kind: "text", text: "中" },
      { kind: "spoiler", children: [{ kind: "text", text: "剧透" }] },
      { kind: "text", text: "后" },
      { kind: "link", href: "https://example.com/a", text: "链接" },
    ]);
  });

  test("markup nests one level: bold inside a spoiler", () => {
    expect(parseInline("~!**秘密**!~")).toEqual([
      { kind: "spoiler", children: [{ kind: "bold", children: [{ kind: "text", text: "秘密" }] }] },
    ]);
  });

  test("unclosed markers are plain text", () => {
    expect(parseInline("**没有闭合 ~!也没有")).toEqual([{ kind: "text", text: "**没有闭合 ~!也没有" }]);
    expect(parseInline("~!!~")).toEqual([{ kind: "text", text: "~!!~" }]);
  });

  test("line breaks are kept", () => {
    expect(parseInline("一\n二")).toEqual([{ kind: "text", text: "一" }, { kind: "break" }, { kind: "text", text: "二" }]);
  });

  test("only http and https become links", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ kind: "text", text: "[x](javascript:alert(1))" }]);
    expect(parseInline("[x](data:text/html,hi)")).toEqual([{ kind: "text", text: "[x](data:text/html,hi)" }]);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://bgm.tv/subject/1")).toBe("https://bgm.tv/subject/1");
    expect(safeHref("not a url")).toBeNull();
  });

  test("markup-looking text never becomes HTML", () => {
    const nodes = parseInline("<script>alert(1)</script>");
    expect(nodes).toEqual([{ kind: "text", text: "<script>alert(1)</script>" }]);
  });
});

describe("parseReview", () => {
  test("blank lines make paragraphs; > lines make a quote", () => {
    expect(parseReview("第一段\n\n> 引用一\n> 引用二\n\n第三段")).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: "第一段" }] },
      { kind: "quote", children: [{ kind: "text", text: "引用一" }, { kind: "break" }, { kind: "text", text: "引用二" }] },
      { kind: "paragraph", children: [{ kind: "text", text: "第三段" }] },
    ]);
  });

  test("a spoiler across a blank line stays one spoiler", () => {
    const blocks = parseReview("前文\n\n~!第一段剧透\n\n第二段剧透!~\n\n后文");
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      children: [
        {
          kind: "spoiler",
          children: [{ kind: "text", text: "第一段剧透" }, { kind: "break" }, { kind: "break" }, { kind: "text", text: "第二段剧透" }],
        },
      ],
    });
  });

  test("CRLF reads like LF and empty input is no blocks", () => {
    expect(parseReview("a\r\n\r\nb")).toHaveLength(2);
    expect(parseReview("  \n\n ")).toEqual([]);
  });

  test("plainText hides every spoiler", () => {
    expect(plainText(parseReview("凶手是~!他!~。\n\n**好看**"))).toBe("凶手是▇▇。 好看");
  });
});

describe("the toolbar edits", () => {
  test("wrap a selection", () => {
    expect(wrapSelection("abc", 1, 2, "**", "**", "粗")).toEqual({ text: "a**b**c", selectionStart: 3, selectionEnd: 4 });
  });

  test("with nothing selected, insert the placeholder selected", () => {
    expect(wrapSelection("ab", 1, 1, "~!", "!~", "剧透")).toEqual({ text: "a~!剧透!~b", selectionStart: 3, selectionEnd: 5 });
  });

  test("quote every touched line", () => {
    expect(quoteSelection("一\n二\n三", 2, 4, "引用").text).toBe("一\n> 二\n> 三");
    expect(quoteSelection("", 0, 0, "引用").text).toBe("> 引用");
  });

  test("link the selection", () => {
    const edit = linkSelection("看这里", 1, 3, "https://example.com", "链接");
    expect(edit.text).toBe("看[这里](https://example.com)");
    expect(parseInline(edit.text)[1]).toEqual({ kind: "link", href: "https://example.com/", text: "这里" });
  });
});
