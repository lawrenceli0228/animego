import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import defaultLoader from "next/dist/shared/lib/image-loader";
import { hasRemoteMatch } from "next/dist/shared/lib/match-remote-pattern";
import { APP_IMAGE_CONFIG, PRODUCTION_MIRROR_BASE, withEnv, withMirror } from "@/lib/test-utils/nextImage";
import { toMirrorUrl } from "./mirror";
import { canOptimize, IMAGE_REMOTE_PATTERNS } from "./remotePatterns";

// canOptimize must say yes to exactly the remote srcs next.config.ts's
// remotePatterns admits. Saying yes to one more is a page that throws under
// `next dev` and a blank image in production; saying no to one admitted is an
// image served unoptimized. The oracle here is Next's own matcher, the
// function next/image and the optimizer call, so `**` means what picomatch
// makes it mean rather than what this file assumes.

/** Next's verdict on a remote src, from the same list. */
const nextAdmits = (src: string) => hasRemoteMatch([], [...IMAGE_REMOTE_PATTERNS], new URL(src));

// [src, what Next does with it]. The second column is asserted against Next
// too, so the table cannot drift into describing a matcher nobody runs.
const REMOTE: [string, boolean][] = [
  // AniList's CDN
  ["https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg", true],
  ["https://s4.anilist.co/file/anilistcdn/character/medium/b176754-5x6wfCKhRrxR.png", true],
  // The optimizer admits the whole prefix; it is the mirror that is narrower.
  ["https://s4.anilist.co/file/anilistcdn/user/avatar/large/b5375227-gXd6p2rIdE1h.png", true],
  ["https://s4.anilist.co/file/anilistcdn", true],
  ["https://s4.anilist.co/file/anilistcdnx/a.jpg", false],
  ["https://s4.anilist.co/file/other/a.jpg", false],
  ["https://s4.anilist.co/", false],
  ["http://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-x.jpg", false],
  ["https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-x.jpg?v=2", false],
  ["https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-x.jpg#top", true],
  // No port in a pattern means any port, to Next and to canOptimize alike.
  ["https://s4.anilist.co:8443/file/anilistcdn/media/anime/cover/large/bx1-x.jpg", true],

  // Our mirror
  ["https://animegoclub.com/img/anilist/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg", true],
  ["https://animegoclub.com/img/anilist/staff/large/n95991-0B7dPZHaFl9X.png", true],
  ["https://animegoclub.com/img/anilist", true],
  ["https://animegoclub.com/img/anilist/", true],
  ["https://animegoclub.com/img/anilist//double-slash.jpg", true],
  ["https://animegoclub.com/img/anilist/.dotfile.jpg", true],
  ["https://animegoclub.com/img/anilist/a/b/c/deep.jpg", true],
  ["https://animegoclub.com/img/anilist/caf%C3%A9.jpg", true],
  ["https://animegoclub.com/img/anilistx/a.jpg", false],
  ["https://animegoclub.com/img/other/a.jpg", false],
  ["https://animegoclub.com/img/anilist/x.jpg?w=1", false],
  // The URL parser resolves the dots before anything matches: /img/secret.jpg.
  ["https://animegoclub.com/img/anilist/../secret.jpg", false],
  ["https://animegoclub.com/img/anilist/%2e%2e/secret.jpg", false],
  ["https://animegoclub.com/api/avatars/1.webp", false],
  ["https://animegoclub.com/_next/image?url=x", false],
  ["https://www.animegoclub.com/img/anilist/x.jpg", false],
  ["https://animegoclub.com./img/anilist/x.jpg", false],
  ["https://ANIMEGOCLUB.COM/img/anilist/x.jpg", true],
  ["https://animegoclub.com/IMG/anilist/x.jpg", false],
  ["http://animegoclub.com/img/anilist/x.jpg", false],

  // YouTube stills
  ["https://i.ytimg.com/vi/kq6ZJNx2Mok/maxresdefault.jpg", true],
  ["https://i.ytimg.com/vi_webp/kq6ZJNx2Mok/maxresdefault.webp", false],
  ["https://i.ytimg.com/vi/kq6ZJNx2Mok/hqdefault.jpg?sqp=-oaymwE", false],

  // Everything else
  ["https://lain.bgm.tv/pic/crt/l/1a/2b/95991_prsn_aBcDe.jpg", false],
  ["https://lain.bgm.tv/pic/crt/l/1a/2b/95991_prsn_aBcDe.jpg?r=1700000000", false],
  ["https://img.example/character.jpg", false],
  ["https://evil.example/file/anilistcdn/x.jpg", false],
  ["https://evil.example/img/anilist/x.jpg", false],
  ["https://s4.anilist.co.evil.example/file/anilistcdn/x.jpg", false],
  ["https://animegoclub.com@evil.example/img/anilist/x.jpg", false],
  ["data:image/png;base64,iVBORw0KGgo=", false],
  ["blob:https://animegoclub.com/7b1c6f1e-5c1a-4a8e-9a3e-1f0c2d3e4f5a", false],
];

describe("canOptimize and next.config's remotePatterns agree", () => {
  test.each(REMOTE)("%s", (src, admitted) => {
    expect(nextAdmits(src)).toBe(admitted);
    expect(canOptimize(src)).toBe(admitted);
  });

  test("every pattern is one canOptimize evaluates exactly, so none is silently refused", () => {
    for (const { protocol, hostname, pathname, search } of IMAGE_REMOTE_PATTERNS) {
      expect(protocol).toBe("https");
      expect(search).toBe("");
      expect(pathname.endsWith("/**")).toBe(true);
      expect(`${hostname}${pathname.slice(0, -3)}`).not.toMatch(/[*?[\]{}()!+@\\]/);
      const inside = `https://${hostname}${pathname.slice(0, -3)}/x.jpg`;
      expect(canOptimize(inside)).toBe(true);
      expect(nextAdmits(inside)).toBe(true);
    }
  });
});

// Paths on this site are governed by localPatterns, not remotePatterns.
// next.config.ts sets none, and Next 16 then fills in
// [{ pathname: "**", search: "" }]. The oracle is next/image's loader itself,
// run the way `next dev` runs it: it throws on anything it refuses.
const nextDevLoaderAccepts = (src: string) =>
  withEnv({ NODE_ENV: "development" }, () => {
    try {
      defaultLoader({ config: APP_IMAGE_CONFIG, src, width: 384, quality: 85 });
      return true;
    } catch {
      return false;
    }
  });

describe("paths on this site", () => {
  const LOCAL: [string, string, boolean][] = [
    ["a plain path", "/community-guide.jpg", true],
    ["a nested path", "/landing/posters/frieren.webp", true],
    ["a protocol-relative URL, which next/image refuses", "//s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-x.jpg", false],
    ["a query string, which Next 16's default localPatterns refuses", "/community-guide.jpg?v=2", false],
  ];

  test.each(LOCAL)("%s", (_, src, accepted) => {
    expect(nextDevLoaderAccepts(src)).toBe(accepted);
    expect(canOptimize(src)).toBe(accepted);
  });

  test("a string that is not a URL is not optimizable (next/image would throw on it)", () => {
    for (const src of ["not a url", "cover.jpg", "s4.anilist.co/file/anilistcdn/x.jpg", " "]) {
      expect(canOptimize(src)).toBe(false);
    }
  });
});

describe("what the mirror produces, the optimizer admits", () => {
  // A build with the switch on must never render a src the allowlist refuses:
  // that is the 500 this whole file is about.
  const ANILIST = [
    "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg",
    "https://s4.anilist.co/file/anilistcdn/media/manga/banner/30002-hbGd1eKmBRJl.jpg",
    "https://s4.anilist.co/file/anilistcdn/character/large/default.jpg",
    "https://s4.anilist.co/file/anilistcdn/staff/medium/n95991-0B7dPZHaFl9X.png",
  ];

  test.each(ANILIST)("%s", (src) => {
    const mirrored = withMirror(PRODUCTION_MIRROR_BASE, () => toMirrorUrl(src));
    expect(mirrored.startsWith(PRODUCTION_MIRROR_BASE)).toBe(true);
    expect(nextAdmits(mirrored)).toBe(true);
    expect(canOptimize(mirrored)).toBe(true);
  });
});

describe("next.config.ts hands Next this list and nothing else", () => {
  const file = join(import.meta.dir, "../../../next.config.ts");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  test("it imports IMAGE_REMOTE_PATTERNS from this module", () => {
    const imported = source.statements.some(
      (s) =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === "./src/lib/images/remotePatterns" &&
        !!s.importClause?.namedBindings &&
        ts.isNamedImports(s.importClause.namedBindings) &&
        s.importClause.namedBindings.elements.some((e) => e.name.text === "IMAGE_REMOTE_PATTERNS" && !e.propertyName),
    );
    expect(imported).toBe(true);
  });

  test("images.remotePatterns is that array, with no entry of its own beside it", () => {
    const initializers: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "remotePatterns") {
        initializers.push(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(initializers).toHaveLength(1);
    const [value] = initializers;
    const isTheList = (e: ts.Expression) => ts.isIdentifier(e) && e.text === "IMAGE_REMOTE_PATTERNS";
    const exact =
      isTheList(value) ||
      (ts.isArrayLiteralExpression(value) &&
        value.elements.length === 1 &&
        ts.isSpreadElement(value.elements[0]) &&
        isTheList(value.elements[0].expression));
    expect(exact).toBe(true);
  });
});
