import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import zhSpa from "./zh-spa.js";
import enSpa from "./en-spa.js";
import zhHantSpa from "./zh-Hant-spa.js";
import { LANGS, type Lang } from "../lib/i18n/lang";

// Client components translate through useLang(), which is backed by the
// *-spa.js dictionaries — NOT by zh.ts / en.ts, which only server
// components read. Nothing links the two sets, so a key added to zh.ts
// alone resolves fine in SSR review and then renders as the literal key
// string in the browser. That is how `library.overflow.rescan` shipped as
// visible UI text: the watch-folder work added five keys to zh.ts/en.ts
// and none to the -spa pair.
//
// t() returns the key itself on a miss (see lib/i18n.ts), so there is no
// runtime error and no console warning to notice. This suite is the only
// thing standing between a missing key and production.

const SRC = join(import.meta.dir, "..");

/**
 * The client-side dictionary for each language, mirroring the DICTS map in
 * lib/lang-client.tsx — the runtime this suite exists to check.
 *
 * Typed `Record<Lang, …>` and iterated via LANGS rather than written as a
 * `[["zh", zhSpa], ["en", enSpa]]` tuple, because that tuple was the one place
 * in the repo where the client locale set was enumerated by hand. A third
 * `*-spa.js` added without editing it would have been covered by nothing: the
 * suite would still pass, still report two green tests, and the new
 * dictionary's missing keys would ship as literal `library.overflow.rescan`
 * strings — exactly the failure this file was written for. Now the map is a
 * compile error until the new dictionary is imported and registered.
 *
 * Not imported from lang-client.tsx directly: that module is a React client
 * component, and this suite is deliberately DOM-free (see testImportHygiene).
 */
const SPA_DICTS: Record<Lang, unknown> = {
  zh: zhSpa,
  en: enSpa,
  "zh-Hant": zhHantSpa,
};

// A key is exempt when its call site passes an explicit defaultValue —
// that is a deliberate "may be absent" contract, e.g. player.dropRelease.
// Detected by looking a bounded distance past the key, which comfortably
// covers a multi-line `t("k", { defaultValue: … })` without needing to
// balance parens.
const DEFAULT_VALUE_LOOKAHEAD = 200;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|jsx?)$/.test(p) && !/\.test\./.test(p) ? [p] : [];
  });
}

function flatten(obj: unknown, prefix = ""): string[] {
  return Object.entries((obj ?? {}) as Record<string, unknown>).flatMap(
    ([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? flatten(v, `${prefix}${k}.`)
        : [`${prefix}${k}`],
  );
}

interface CallSite {
  file: string;
  line: number;
  key: string;
}

/** Every t("…") call, without a defaultValue, in a file that uses useLang(). */
function clientTranslationCalls(): CallSite[] {
  const out: CallSite[] = [];
  for (const file of walk(SRC)) {
    // The translator modules themselves only mention keys in doc examples.
    if (/lib\/(i18n\.ts|lang-client\.tsx)$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    if (!src.includes("useLang(")) continue;
    for (const m of src.matchAll(/\bt\(\s*["'`]([\w.]+)["'`]/g)) {
      const idx = m.index ?? 0;
      const window = src.slice(idx, idx + DEFAULT_VALUE_LOOKAHEAD);
      if (window.includes("defaultValue")) continue;
      out.push({
        file: file.slice(SRC.length + 1),
        line: src.slice(0, idx).split("\n").length,
        key: m[1],
      });
    }
  }
  return out;
}

describe("*-spa dictionaries cover every client t() key", () => {
  const calls = clientTranslationCalls();

  test("the scan actually finds call sites", () => {
    // Guards the guard: a regex or path change that silently matches
    // nothing would make every assertion below vacuously pass.
    expect(calls.length).toBeGreaterThan(50);
  });

  test("every language in LANGS has a registered dictionary", () => {
    // Guards the guard, second half: SPA_DICTS is typed, but tsc cannot stop
    // someone from satisfying a new key with `undefined` or `{}` to get the
    // build green. flatten() would then yield zero keys and the per-language
    // test below would report every call site as missing — loud, but only if
    // the entry exists at all.
    for (const lang of LANGS) {
      expect(flatten(SPA_DICTS[lang]).length).toBeGreaterThan(50);
    }
  });

  for (const lang of LANGS) {
    test(`${lang}-spa.js resolves them all`, () => {
      const known = new Set(flatten(SPA_DICTS[lang]));
      const missing = calls
        .filter((c) => !known.has(c.key))
        .map((c) => `${c.file}:${c.line}  ${c.key}`);
      expect(missing).toEqual([]);
    });
  }

  // ── Keys the scanner structurally cannot find ────────────────────────────
  //
  // `clientTranslationCalls()` matches `t("literal")`. A call site that looks
  // the key up first — `t(TABLE[mode])`, `t(cond ? a : b)` — is invisible to
  // it, and the miss is silent in exactly the way this whole file exists to
  // prevent: `t()` returns the key itself, so the dictionary key ships as
  // visible UI text with green CI and no console warning.
  //
  // Proven, not assumed. Deleting all three episode-title-mode labels from
  // every *-spa.js at once left the suite at 33 pass / 0 fail. They looked
  // covered because zh and zh-Hant are held together by hantDictParity's
  // key-set equality — but that only catches ASYMMETRIC drift between those
  // two, and a reformat or a "these look unused" cleanup takes both.
  //
  // This list is the manual half of the gate. Add to it whenever you write a
  // `t(variable)` in a client component. It is NOT complete for the repo as it
  // stands: 13 other indirect call sites already ship unguarded
  // (EnrichmentSection, EnrichmentBar, FollowButton, PrivateProfileState,
  // ProfileSafetyActions, FilterChips, OpsLogDrawer). Adding them is welcome
  // and is somebody's separate piece of work — each one needs its key set read
  // off the source rather than guessed, which is why they are not here yet.
  const INDIRECT_KEYS: ReadonlyArray<{ key: string; site: string }> = [
    // components/anime/EpisodesGrid.tsx — TITLE_MODE_LABEL[mode]
    { key: "detail.epTitleLocalized", site: "EpisodesGrid TITLE_MODE_LABEL" },
    { key: "detail.epTitleOriginal", site: "EpisodesGrid TITLE_MODE_LABEL" },
    { key: "detail.epTitleBoth", site: "EpisodesGrid TITLE_MODE_LABEL" },
  ];

  test("the indirect-key list still describes real call sites", () => {
    // Guards the guard: a list that outlived its call site would go on
    // demanding keys nobody reads, and the next person would delete the keys
    // rather than the list. Every entry has to be traceable to a file that
    // still mentions it.
    const sources = walk(SRC)
      .filter((f) => !/locales\//.test(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const orphaned = INDIRECT_KEYS.filter((k) => !sources.includes(k.key)).map(
      (k) => `${k.key} (${k.site})`,
    );
    expect(orphaned).toEqual([]);
  });

  for (const lang of LANGS) {
    test(`${lang}-spa.js resolves the indirect keys too`, () => {
      const known = new Set(flatten(SPA_DICTS[lang]));
      const missing = INDIRECT_KEYS.filter((k) => !known.has(k.key)).map(
        (k) => `${k.key}  ← ${k.site}`,
      );
      expect(missing).toEqual([]);
    });
  }
});
