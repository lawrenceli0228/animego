import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import RouteErrorBody, {
  BACK_HOME,
  BODY,
  RELOAD,
  TITLE,
  type ErrorScope,
} from "./RouteErrorBody";
import { LANGS, type Lang } from "../../lib/i18n/lang";
import { LanguageProvider } from "../../lib/lang-client";

// renderToStaticMarkup from react-dom/server, following
// ActivitySection.render.test.tsx: no jsdom, no testing-library, no new
// dependency.
//
// Every language is rendered for real, by wrapping the component in
// LanguageProvider — useLang() reads the provider's value first and only falls
// back to usePathname() when there is no provider to read. An earlier version
// of this file asserted the other two languages off the copy tables alone and
// said in a comment that useLang() had "no seam to inject a locale through".
// That was wrong, and it mattered: table assertions prove the strings exist,
// not that the component reaches for the right one. A component that read
// TITLE[scope].zh unconditionally would have passed the whole suite.
//
// What still cannot be reached by rendering is the retry button's BEHAVIOUR.
// renderToStaticMarkup attaches no handlers, and which function that handler
// calls is the entire point of this change, so it is asserted against the
// source text at the bottom of this file. That is a weaker instrument than a
// click and it is the one available here; it is written to fail on the
// regression rather than on a reformat, and it was checked by making the
// regression and watching it go red.

const SRC = join(import.meta.dir, "..", "..");

/**
 * Source with comments removed, so an assertion about what the CODE does is
 * not answered by prose that happens to mention the same call.
 *
 * Written after the first version of the `reset` assertion below failed on the
 * sentence explaining why `reset` is avoided — the comment is the point, and a
 * guard that forbids naming the thing it guards against is a guard nobody can
 * document around. Naive on purpose: it does not understand `//` inside a
 * string literal, and none of the three files it reads contains one.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Trailing comments too, not just whole-line ones. The first version
    // anchored at ^, so `something(); // reset()` kept the prose and any
    // assertion built on this could be satisfied by a comment sitting to the
    // right of real code. `(?<!:)` spares `https://` in a string literal,
    // which is the only other `//` these three files can contain.
    .replace(/(?<!:)\/\/.*$/gm, "");
}

function err(digest?: string): Error & { digest?: string } {
  return Object.assign(new Error("boom"), digest ? { digest } : {});
}

/** The component as a reader in `lang` sees it. */
function renderIn(lang: Lang, scope: ErrorScope, digest?: string): string {
  return renderToStaticMarkup(
    <LanguageProvider lang={lang}>
      <RouteErrorBody error={err(digest)} scope={scope} />
    </LanguageProvider>,
  );
}

const SCOPES: ErrorScope[] = ["detail", "seasonal"];

describe("RouteErrorBody renders in every language", () => {
  for (const lang of LANGS) {
    for (const scope of SCOPES) {
      test(`${lang} / ${scope}: headline, body, reload button, way home`, () => {
        const html = renderIn(lang, scope);
        expect(html).toContain(TITLE[scope][lang]);
        expect(html).toContain(BODY[lang]);
        expect(html).toContain(RELOAD[lang]);
        expect(html).toContain(BACK_HOME[lang]);
        expect(html).toContain("<button");
        expect(html).toContain('href="/"');
      });
    }

    test(`${lang}: no other language leaks in`, () => {
      // The failure this catches is a component that resolves the locale once
      // and then indexes a table with a constant — every string present, every
      // string wrong for two readers out of three.
      const html = renderIn(lang, "detail");
      for (const other of LANGS) {
        if (other === lang) continue;
        expect(html).not.toContain(TITLE.detail[other]);
        expect(html).not.toContain(BODY[other]);
      }
    });
  }

  test("without a provider it still renders, in the default language", () => {
    // Error boundaries sit under the root layout, so LanguageProvider is
    // normally above them. "Normally" is not "always" — useLang() falls back to
    // the path-derived locale, which with no router resolves to zh. Pinned
    // because the fallback throwing would turn an error page into a blank one.
    const html = renderToStaticMarkup(
      <RouteErrorBody error={err()} scope="detail" />,
    );
    expect(html).toContain(TITLE.detail.zh);
  });
});

describe("RouteErrorBody renders the right thing", () => {
  test("the two scopes do not share a headline", () => {
    // The scope prop is the only thing distinguishing the two boundaries. If
    // it stopped being read, both routes would still render — with the wrong
    // one of these two sentences, and nothing else would fail.
    const detail = renderIn("zh", "detail");
    expect(detail).toContain(TITLE.detail.zh);
    expect(detail).not.toContain(TITLE.seasonal.zh);
  });

  test("the digest shows when there is one and is absent when there is not", () => {
    // The digest is what matches a report to the server-side log. It was
    // conditional in both files this replaced; keep it that way rather than
    // rendering an empty mono line on client-side errors, which carry none.
    expect(renderIn("zh", "detail", "a1b2c3d4")).toContain("a1b2c3d4");
    expect(renderIn("zh", "detail")).not.toContain("JetBrains Mono");
  });

  test("the copy does not blame the upstream any more", () => {
    // The sentence this replaced named a cause the page cannot know, and named
    // the wrong one for 17 of 17 recorded events. Pinned so a well-meaning copy
    // edit does not restore it.
    for (const lang of LANGS) {
      expect(renderIn(lang, "detail")).not.toContain("上游");
      expect(BODY[lang]).not.toContain("上游");
      expect(BODY[lang].toLowerCase()).not.toContain("upstream");
    }
  });

  test("no straight apostrophe survives into the English copy", () => {
    // React escapes ' to &#x27;. Invisible to a reader, and it broke the first
    // version of the assertions above — the copy uses U+2019 instead, and this
    // is what stops the next edit from typing the straight one back.
    const english = [
      TITLE.detail.en,
      TITLE.seasonal.en,
      BODY.en,
      RELOAD.en,
      BACK_HOME.en,
    ];
    for (const s of english) expect(s).not.toContain("'");
  });
});

describe("RouteErrorBody copy covers every language", () => {
  test("every table has a non-empty entry for every LANG", () => {
    // Record<Lang, string> already makes a missing language a compile error.
    // This catches the other half — an entry that exists and says nothing,
    // which tsc is happy with and a visitor is not.
    const tables: Array<[string, Record<string, string>]> = [
      ["TITLE.detail", TITLE.detail],
      ["TITLE.seasonal", TITLE.seasonal],
      ["BODY", BODY],
      ["RELOAD", RELOAD],
      ["BACK_HOME", BACK_HOME],
    ];
    const empty: string[] = [];
    for (const [name, table] of tables) {
      for (const lang of LANGS) {
        if (!table[lang] || table[lang].trim() === "")
          empty.push(`${name}.${lang}`);
      }
    }
    expect(empty).toEqual([]);
  });

  test("the three languages actually differ", () => {
    // A copy-paste that left zh-Hant holding the Simplified string would pass
    // every check above. The Traditional and Simplified forms of these
    // particular sentences differ in at least one character each, so equality
    // means somebody skipped the conversion.
    for (const table of [TITLE.detail, TITLE.seasonal, BODY, RELOAD, BACK_HOME]) {
      expect(table.zh).not.toBe(table["zh-Hant"]);
      expect(table.zh).not.toBe(table.en);
    }
  });

  // Mirrors locales/hantVocabulary.test.ts, which runs this check over the
  // dictionaries. These strings live in a .tsx and so are outside its reach —
  // the standing cost of keeping copy out of the dictionaries, paid here rather
  // than left unpaid.
  const SIMPLIFIED_ONLY: Array<[string, string]> = [
    ["页", "頁"],
    ["载", "載"],
    ["剧", "劇"],
    ["试", "試"],
    ["过", "過"],
    ["别", "別"],
    ["会", "會"],
    ["还", "還"],
    ["来", "來"],
    ["个", "個"],
    ["间", "間"],
    ["题", "題"],
    ["关", "關"],
    ["数", "數"],
  ];

  for (const [simp, trad] of SIMPLIFIED_ONLY) {
    test(`zh-Hant copy contains no ${simp} (want ${trad})`, () => {
      const hits = [
        ["TITLE.detail", TITLE.detail["zh-Hant"]],
        ["TITLE.seasonal", TITLE.seasonal["zh-Hant"]],
        ["BODY", BODY["zh-Hant"]],
        ["RELOAD", RELOAD["zh-Hant"]],
        ["BACK_HOME", BACK_HOME["zh-Hant"]],
      ]
        .filter(([, value]) => value.includes(simp))
        .map(([name, value]) => `${name}: ${value}`);
      expect(hits).toEqual([]);
    });
  }
});

describe("the retry button reloads rather than resetting", () => {
  const BODY_SRC = readFileSync(
    join(SRC, "components/error/RouteErrorBody.tsx"),
    "utf8",
  );
  const BOUNDARIES: Array<{ file: string; scope: ErrorScope }> = [
    { file: "app/[lang]/anime/[id]/error.tsx", scope: "detail" },
    { file: "app/[lang]/seasonal/[season]/[year]/error.tsx", scope: "seasonal" },
  ];

  test("the source this suite reads is the real component", () => {
    // Guards the guard. A moved or renamed file would make every assertion
    // below read something else, or an empty string, and pass.
    expect(BODY_SRC).toContain("export default function RouteErrorBody");
  });

  test("the handler calls window.location.reload()", () => {
    expect(codeOnly(BODY_SRC)).toContain("window.location.reload()");
  });

  test("the boundary still reports to Sentry", () => {
    // An error.tsx boundary swallows the error before the SDK's global
    // handlers see it, so this call is the only reason either route is
    // observable at all — the issue that motivated this whole change is known
    // only because it was there.
    //
    // Deleting the effect passes everything else: 33 green, and `tsc --noEmit`
    // stays clean too, because tsconfig.json does not set noUnusedLocals, so
    // even the orphaned `import * as Sentry` raises nothing. Sentry would go
    // quiet, which reads as "fixed".
    expect(codeOnly(BODY_SRC)).toContain("Sentry.captureException(error)");
  });

  test("no boundary takes reset out of its props", () => {
    // `reset()` re-renders the children without re-fetching them (Next's own
    // docs), so on the client-side module error it reproduces the same throw.
    // Taking the prop is the first step back to that, and it is a one-word
    // edit; this is the thing that notices.
    for (const { file } of BOUNDARIES) {
      const code = codeOnly(readFileSync(join(SRC, file), "utf8"));
      expect(code).toContain("RouteErrorBody");
      // `\??` because `reset?: () => void` is the shape a props interface
      // would actually use, and without it the guard reads right past the
      // one declaration most likely to be written.
      expect(code).not.toMatch(/\breset\s*\??\s*[,:}]/);
      expect(code).not.toMatch(/\breset\s*\(\s*\)/);
    }
    expect(codeOnly(BODY_SRC)).not.toMatch(/\breset\s*\(\s*\)/);
  });

  test("each boundary passes its own scope", () => {
    // Nothing else notices this. Both files render, both produce a coherent
    // error page, and the seasonal route apologises for "this page" — the one
    // sentence that distinguishes them, wrong, with every test green. Swapping
    // the two literals is a plausible copy-paste and was undetectable until
    // this assertion.
    for (const { file, scope } of BOUNDARIES) {
      const code = codeOnly(readFileSync(join(SRC, file), "utf8"));
      expect(code).toContain(`scope="${scope}"`);
      const other = scope === "detail" ? "seasonal" : "detail";
      expect(code).not.toContain(`scope="${other}"`);
    }
  });
});
