import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// Every file that hands a src to next/image itself must point AniList URLs at
// the mirror first, or the images it renders keep coming from AniList with
// nothing anywhere saying so. The ways to satisfy that:
//
//  - call toMirrorUrl (lib/images/mirror.ts) on the src;
//  - render through FadeImage, which calls it (and must: checked below);
//  - always pass `unoptimized` -- the library and player surfaces, whose srcs
//    may be any host and must never become fetches our server makes;
//  - or be listed in ALLOWED, with the reason the file never renders an
//    AniList image.
//
// The check is per file, and it reads the syntax tree rather than the text,
// so an import mentioned in a comment does not count, and neither does an
// `import type` (a type renders nothing). Per file is also its limit: a file
// that passes because it renders FadeImage or calls toMirrorUrl once could
// still hand next/image an AniList URL somewhere else. The render tests cover
// that for the surfaces that matter, DetailHero's own banner among them.

const SRC = join(import.meta.dir, "../..");

/** Files that use next/image without the mirror rewrite, and why that is right. */
const ALLOWED: Record<string, string> = {
  "components/anime/TrailerPreview.tsx": "YouTube trailer stills (i.ytimg.com) only; renders no AniList image.",
};

const NEXT_IMAGE_MODULES = new Set(["next/image", "next/legacy/image"]);

interface Usage {
  /** Imports a value from next/image, re-exports it, requires it, or calls getImageProps. */
  usesNextImage: boolean;
  callsToMirrorUrl: boolean;
  rendersFadeImage: boolean;
  /** Passes `unoptimized` as a literal true (a computed value proves nothing). */
  alwaysUnoptimized: boolean;
}

const isNextImageSpecifier = (node: ts.Node | undefined) =>
  !!node && ts.isStringLiteral(node) && NEXT_IMAGE_MODULES.has(node.text);

function importsAValue(decl: ts.ImportDeclaration): boolean {
  const clause = decl.importClause;
  if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  return ts.isNamespaceImport(bindings) || bindings.elements.some((e) => !e.isTypeOnly);
}

function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

const isLiteralTrue = (node: ts.Node | undefined) => !!node && node.kind === ts.SyntaxKind.TrueKeyword;

function inspect(fileName: string, text: string): Usage {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const usage: Usage = { usesNextImage: false, callsToMirrorUrl: false, rendersFadeImage: false, alwaysUnoptimized: false };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && isNextImageSpecifier(node.moduleSpecifier) && importsAValue(node)) {
      usage.usesNextImage = true;
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && isNextImageSpecifier(node.moduleSpecifier)) {
      usage.usesNextImage = true;
    } else if (ts.isCallExpression(node)) {
      const isLoad =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (isLoad && isNextImageSpecifier(node.arguments[0])) usage.usesNextImage = true;
      const name = calleeName(node.expression);
      if (name === "getImageProps") usage.usesNextImage = true;
      if (name === "toMirrorUrl") usage.callsToMirrorUrl = true;
    } else if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(source) === "FadeImage"
    ) {
      usage.rendersFadeImage = true;
    } else if (ts.isJsxAttribute(node) && node.name.getText(source) === "unoptimized") {
      const value = node.initializer;
      if (!value || (ts.isJsxExpression(value) && isLiteralTrue(value.expression))) usage.alwaysUnoptimized = true;
    } else if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "unoptimized" &&
      isLiteralTrue(node.initializer)
    ) {
      usage.alwaysUnoptimized = true;
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

// A file whose text never names the module or getImageProps cannot use
// either, so only the rest are parsed: parsing all of src/ is most of the
// cost of this file.
const MENTIONS_NEXT_IMAGE = /next\/(legacy\/)?image|getImageProps/;
const USAGE = new Map(
  walk(SRC)
    .map((file) => [relative(SRC, file), readFileSync(file, "utf8")] as const)
    .filter(([, text]) => MENTIONS_NEXT_IMAGE.test(text))
    .map(([file, text]) => [file, inspect(file, text)] as const),
);
const NEXT_IMAGE_FILES = [...USAGE].filter(([, u]) => u.usesNextImage).map(([file]) => file);

describe("the scanner reads code, not text", () => {
  const cases: [string, string, Partial<Usage>][] = [
    ["a default import", `import Image from "next/image";`, { usesNextImage: true }],
    ["getImageProps", `import { getImageProps } from "next/image";\nconst p = getImageProps({ src, alt: "", width: 1, height: 1 });`, { usesNextImage: true }],
    ["a type-only import", `import type { ImageProps } from "next/image";`, { usesNextImage: false }],
    ["an import in a comment", `// import Image from "next/image";\n/* getImageProps({}) */`, { usesNextImage: false }],
    ["an import in a string", `const s = 'import Image from "next/image"';`, { usesNextImage: false }],
    ["a re-export", `export { default } from "next/image";`, { usesNextImage: true }],
    ["a dynamic import", `const m = await import("next/image");`, { usesNextImage: true }],
    ["a toMirrorUrl call", `const s = toMirrorUrl(url);`, { callsToMirrorUrl: true }],
    ["toMirrorUrl named in a comment", `// toMirrorUrl(url)`, { callsToMirrorUrl: false }],
    ["a FadeImage element", `const e = <FadeImage src={s} alt="" width={1} height={1} />;`, { rendersFadeImage: true }],
    ["a bare unoptimized", `const e = <Image unoptimized src={s} alt="" />;`, { alwaysUnoptimized: true }],
    ["unoptimized={true}", `const e = <Image unoptimized={true} src={s} alt="" />;`, { alwaysUnoptimized: true }],
    ["a computed unoptimized", `const e = <Image unoptimized={!ok} src={s} alt="" />;`, { alwaysUnoptimized: false }],
    ["unoptimized: true in getImageProps", `getImageProps({ src, unoptimized: true });`, { alwaysUnoptimized: true }],
  ];

  test.each(cases)("%s", (_, code, expected) => {
    expect(inspect("sample.tsx", code)).toMatchObject(expected);
  });
});

describe("every next/image call site goes through the mirror rewrite", () => {
  test("the scan found the known call sites (guards against a scanner that matches nothing)", () => {
    for (const known of [
      "components/ui/FadeImage.tsx",
      "app/[lang]/anime/[id]/_detail/DetailHero.tsx",
      "components/home/HomeHero.tsx",
      "components/anime/TrailerPreview.tsx",
    ]) {
      expect(NEXT_IMAGE_FILES).toContain(known);
    }
  });

  test("FadeImage itself calls toMirrorUrl: every component that renders through it relies on that", () => {
    // Its own `unoptimized={...}` is computed, so it does not excuse it.
    expect(USAGE.get("components/ui/FadeImage.tsx")?.callsToMirrorUrl).toBe(true);
  });

  test("no file renders next/image around the rewrite", () => {
    const offenders = NEXT_IMAGE_FILES.filter((file) => {
      const u = USAGE.get(file)!;
      return !(u.callsToMirrorUrl || u.rendersFadeImage || u.alwaysUnoptimized || file in ALLOWED);
    });

    expect(
      offenders,
      offenders.length
        ? "These files use next/image without pointing AniList URLs at the mirror.\n" +
            "Render through FadeImage, or pass the src through toMirrorUrl\n" +
            "(lib/images/mirror.ts) as DetailHero and HomeHero do. A src that can be\n" +
            "any host should be `unoptimized`. A file that never shows an AniList\n" +
            "image goes in ALLOWED in this test, with the reason.\n\n  " +
            offenders.join("\n  ")
        : undefined,
    ).toEqual([]);
  });

  test("every ALLOWED entry still exists and still uses next/image", () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(NEXT_IMAGE_FILES).toContain(file);
    }
  });
});
