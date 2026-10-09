import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// A plain <img>, or a CSS background built with cssUrl(), is fetched by the
// browser exactly as written. For an AniList URL that means straight from
// AniList's CDN, full size, past the mirror and the optimizer -- which is how
// profile backdrops, member-pass art and every avatar standing in for a member
// without a photo were still loading after the mirror shipped. So every file
// that renders an <img> or builds a CSS url() must pass its source through
// lib/images/anilistImg.ts (anilistImgProps or anilistImageSrc), which leaves
// anything that is not an AniList image alone. A file that never shows an
// AniList image goes in ALLOWED, with the reason.
//
// next/image and FadeImage are lib/images/nextImageCallSites.test.ts's
// business, not this file's. Like that test, this one reads the syntax tree,
// so an <img> in a comment or a string does not count, and works per file:
// a file that calls the helpers once passes even if another <img> in it does
// not. The render tests cover the surfaces that matter.

const SRC = join(import.meta.dir, "../..");

/** Files that render an <img> or a cssUrl() without the helpers, and why that is right. */
const ALLOWED: Record<string, string> = {
  "components/home/HomeHero.tsx":
    "Its <img> elements spread props from heroImages.ts, which point AniList URLs at the mirror (heroImages.test.ts).",
  "components/profile/PhotoCropModal.tsx": "Shows the photo a member is cropping, read from their own file.",
};

const HELPERS = new Set(["anilistImgProps", "anilistImageSrc"]);

interface Usage {
  /** Renders an <img> element. */
  rendersImg: boolean;
  /** Calls cssUrl(), i.e. builds a CSS background from a URL. */
  buildsCssUrl: boolean;
  /** Calls anilistImgProps or anilistImageSrc. */
  callsHelper: boolean;
}

function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function inspect(fileName: string, text: string): Usage {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const usage: Usage = { rendersImg: false, buildsCssUrl: false, callsHelper: false };

  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "img") {
      usage.rendersImg = true;
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === "cssUrl") usage.buildsCssUrl = true;
      if (name && HELPERS.has(name)) usage.callsHelper = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return usage;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    if (!/\.(tsx?|jsx?|mjs)$/.test(name) || /\.test\.[jt]sx?$/.test(name) || name.endsWith(".d.ts")) return [];
    return [path];
  });
}

// Only files whose text mentions an <img or cssUrl can render or build one;
// parsing the rest of src/ would be most of this file's cost.
const MENTIONS = /<img\b|cssUrl\s*\(/;
const USAGE = new Map(
  walk(SRC)
    .map((file) => [relative(SRC, file), readFileSync(file, "utf8")] as const)
    .filter(([, text]) => MENTIONS.test(text))
    .map(([file, text]) => [file, inspect(file, text)] as const),
);
const PLAIN_IMAGE_FILES = [...USAGE].filter(([, u]) => u.rendersImg || u.buildsCssUrl).map(([file]) => file);

describe("the scanner reads code, not text", () => {
  const cases: [string, string, Partial<Usage>][] = [
    ["an <img> element", `const e = <img src={s} alt="" />;`, { rendersImg: true }],
    ["an <img> with children syntax", `const e = <img src={s} alt=""></img>;`, { rendersImg: true }],
    ["an <img> in a comment", `// <img src={s} />\nconst e = null;`, { rendersImg: false }],
    ["an <img> in a string", `const s = '<img src="x" />';`, { rendersImg: false }],
    ["another element", `const e = <Image src={s} alt="" />;`, { rendersImg: false }],
    ["a cssUrl call", `const bg = cssUrl(u, d);`, { buildsCssUrl: true }],
    ["cssUrl named in a comment", `// cssUrl(u, d)`, { buildsCssUrl: false }],
    ["anilistImgProps", `const e = <img {...anilistImgProps(u, 1, 1)} alt="" />;`, { rendersImg: true, callsHelper: true }],
    ["anilistImageSrc", `const bg = cssUrl(anilistImageSrc(u, 1), d);`, { buildsCssUrl: true, callsHelper: true }],
  ];

  test.each(cases)("%s", (_, code, expected) => {
    expect(inspect("sample.tsx", code)).toMatchObject(expected);
  });
});

describe("every plain <img> and CSS url() goes through the AniList helpers", () => {
  test("the scan found the known call sites (guards against a scanner that matches nothing)", () => {
    for (const known of [
      "components/ui/FallbackImg.tsx",
      "components/layout/AvatarMenu.tsx",
      "components/profile/MemberPass.tsx",
      "app/[lang]/u/[username]/_components/PublicProfileHero.tsx",
      "components/home/HomeHero.tsx",
    ]) {
      expect(PLAIN_IMAGE_FILES).toContain(known);
    }
  });

  test("FallbackImg itself calls the helper: every avatar that falls back to a cover relies on that", () => {
    expect(USAGE.get("components/ui/FallbackImg.tsx")?.callsHelper).toBe(true);
  });

  test("no file renders a plain <img> or a CSS url() around the helpers", () => {
    const offenders = PLAIN_IMAGE_FILES.filter((file) => !(USAGE.get(file)!.callsHelper || file in ALLOWED));

    expect(
      offenders,
      offenders.length
        ? "These files render a plain <img> or build a CSS url() without lib/images/anilistImg.ts,\n" +
            "so an AniList URL among their sources is fetched straight from AniList, full size.\n" +
            "Pass the source through anilistImgProps (an <img>) or anilistImageSrc (a background,\n" +
            "or an <img> that needs a single src). A file that never shows an AniList image goes\n" +
            "in ALLOWED in this test, with the reason.\n\n  " +
            offenders.join("\n  ")
        : undefined,
    ).toEqual([]);
  });

  test("every ALLOWED entry still exists and still renders an <img> or a CSS url()", () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(PLAIN_IMAGE_FILES).toContain(file);
    }
  });
});
