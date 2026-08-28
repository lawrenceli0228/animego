import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// A route that can answer "not found" must not sit behind a Suspense boundary.
//
// The mechanism, measured: a `loading.tsx` wraps its own folder's page and
// everything below it in a Suspense boundary. The response starts streaming as
// soon as that fallback renders, the headers go out, and from then on the
// status code is frozen — so a later `notFound()` can only be delivered as an
// error inside the RSC stream, and the visitor gets HTTP 200 with a not-found
// body. Google calls that a soft 404. `redirect()` and `permanentRedirect()`
// freeze the same way and degrade to a client-side navigation.
//
// That is why this is a positional rule and not a reachability one. The naive
// version of this test asks "does this route call notFound()?" and flags all 24
// of them, because `resolveLocale` calls it and 20 pages plus all 4 layouts
// import that. A test that fails everywhere gets deleted within a week. The
// question that matters is narrower:
//
//   for each Suspense boundary, can anything INSIDE it reach notFound()?
//
// Two things follow from "inside", and both are easy to get wrong:
//
//   · The boundary's own `page.tsx` counts. All the real violations are a
//     `loading.tsx` sitting next to the page it wraps, so a walker that starts
//     at the parent directory finds nothing.
//
//   · The boundary's own `layout.tsx` does NOT count. Next nests `loading.js`
//     inside the same folder's `layout.js`, so the layout renders outside the
//     boundary it creates. `[lang]/layout.tsx` calls notFound() through
//     resolveLocale and that is exactly how an invalid locale still produces a
//     real 404 today — flagging it would flag the one call site that works.

const APP = import.meta.dir;
const SRC = resolve(APP, "..");

/** Route-file kinds that render INSIDE a sibling loading.tsx's boundary. */
const INSIDE_BOUNDARY = ["page.tsx", "template.tsx", "default.tsx"] as const;
/** …plus these, but only for segments strictly BELOW the boundary. */
const BELOW_BOUNDARY = [...INSIDE_BOUNDARY, "layout.tsx"] as const;

/**
 * Boundaries that are allowed to contain a notFound() reacher, each with the
 * reason it is safe. An entry that no longer describes a violation fails the
 * staleness check below — an allowlist nobody prunes is how a rule dies.
 *
 * All three entries are the same shape: the page calls `resolveLocale` a second
 * time for a `[lang]` check that `[lang]/layout.tsx` already performed ABOVE
 * this boundary. The layout throws first, on the same params, so the page's
 * copy can never be the call that decides a 404. The real fix is to split
 * resolveLocale into a throwing variant for layouts and a non-throwing one for
 * pages, which empties this list — see TODOS.md.
 */
const ALLOWED: Record<string, string> = {
  "[lang]/(home)": "redundant resolveLocale; [lang]/layout.tsx checks the same params above this boundary",
  "[lang]/search": "redundant resolveLocale; [lang]/layout.tsx checks the same params above this boundary",
  "[lang]/welcome": "redundant resolveLocale; [lang]/layout.tsx checks the same params above this boundary",
};

/** Symbols that freeze the status code once the response has begun streaming. */
const FREEZING = ["notFound", "redirect", "permanentRedirect"] as const;

// ── source scanning ────────────────────────────────────────────────────────

/**
 * Comments removed, string literals kept.
 *
 * This repo discusses this exact bug at length in prose — `layout.tsx`,
 * `not-found.tsx` and several tests all contain the literal `notFound()` inside
 * a comment — so comments have to go before any call is matched.
 *
 * Strings stay, because an import specifier IS a string: stripping both in one
 * pass turns `from "next/navigation"` into `from ""`, no module resolves, the
 * taint set comes out empty and every assertion below passes vacuously. That is
 * exactly what the first version of this file did, and only the seed guard
 * caught it.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

/**
 * Comments AND string literals removed — for matching CALLS only.
 *
 * `library.localSeries.notFound` is a dictionary key and the locale files
 * declare a `notFound:` property; without this they would all read as call
 * sites.
 */
function callable(src: string): string {
  return stripComments(src)
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""');
}

/** Every .ts/.tsx under src/, so the taint walk can follow imports anywhere. */
function allSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allSources(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Resolve one import specifier to a file on disk.
 *
 * Lifted from testImportHygiene.test.ts, including the ordering that makes
 * `@/lib/i18n` resolve to `lib/i18n.ts` and not the `lib/i18n/` directory that
 * also exists — getting that backwards silently drops route.ts from the graph,
 * which is where the only real notFound() vector lives.
 */
function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else return null;

  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* not this one */
    }
  }
  return null;
}

function importsOf(file: string, src: string): string[] {
  return [...src.matchAll(/from\s+["']([^"']+)["']/g)]
    .map((m) => resolveLocal(file, m[1]))
    .filter((p): p is string => p !== null);
}

// ── taint ──────────────────────────────────────────────────────────────────

const SOURCES = allSources(SRC);
/** Comments gone, strings intact — used for imports and for boundary detection. */
const CODE = new Map(SOURCES.map((f) => [f, stripComments(readFileSync(f, "utf8"))]));
/** Strings gone too — used only for deciding whether something is CALLED. */
const CALLS = new Map([...CODE].map(([f, src]) => [f, callable(src)]));

/** Modules that call a freezing symbol imported from next/navigation. */
function seeds(): Set<string> {
  const out = new Set<string>();
  for (const [file, src] of CODE) {
    if (!/from\s+["']next\/navigation["']/.test(src)) continue;
    const calls = CALLS.get(file)!;
    if (FREEZING.some((sym) => new RegExp(`\\b${sym}\\s*\\(`).test(calls))) out.add(file);
  }
  return out;
}

/**
 * Files that reach a freezing call, and the shortest path to it.
 *
 * Over-approximates: importing route.ts only for `localeParams` still taints,
 * because this walks the module graph rather than the symbol graph. That is the
 * right direction to be wrong in — a false positive costs one allowlist line
 * with a reason, a false negative costs a soft 404 on a page nobody is
 * watching.
 */
function taint(): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const queue: string[] = [];
  for (const s of seeds()) {
    paths.set(s, [s]);
    queue.push(s);
  }
  // Reverse edges: who imports the tainted module.
  const importers = new Map<string, string[]>();
  for (const [file, src] of CODE) {
    for (const dep of importsOf(file, src)) {
      (importers.get(dep) ?? importers.set(dep, []).get(dep)!).push(file);
    }
  }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const importer of importers.get(cur) ?? []) {
      if (paths.has(importer)) continue;
      paths.set(importer, [importer, ...paths.get(cur)!]);
      queue.push(importer);
    }
  }
  return paths;
}

const TAINTED = taint();

// ── boundaries ─────────────────────────────────────────────────────────────

/** Directories that open a Suspense boundary over their own page + children. */
function boundaries(): string[] {
  const out: string[] = [];
  for (const file of allSources(APP)) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (name === "loading.tsx") out.push(dirname(file));
    // A hand-written <Suspense> in a layout or template freezes the status the
    // same way and no filename check would ever see it.
    else if (name === "layout.tsx" || name === "template.tsx") {
      if (/<Suspense[\s>]/.test(CODE.get(file) ?? "")) out.push(dirname(file));
    }
  }
  return [...new Set(out)];
}

function filesInside(boundary: string): string[] {
  const out: string[] = [];
  for (const kind of INSIDE_BOUNDARY) {
    const f = join(boundary, kind);
    if (CODE.has(f)) out.push(f);
  }
  for (const f of allSources(boundary)) {
    if (f.startsWith(`${boundary}/`) && dirname(f) !== boundary) {
      const name = f.slice(f.lastIndexOf("/") + 1);
      if ((BELOW_BOUNDARY as readonly string[]).includes(name)) out.push(f);
    }
  }
  return out;
}

const rel = (f: string) => relative(APP, f);
const BOUNDARIES = boundaries();

// ── the checks ─────────────────────────────────────────────────────────────

describe("the scan actually scanned", () => {
  // Every assertion below is vacuously true if a glob broke. This repo has
  // shipped a green suite that tested nothing before; these are the guards.
  test("found the app's route files", () => {
    const pages = allSources(APP).filter((f) => f.endsWith("/page.tsx"));
    expect(pages.length).toBeGreaterThan(20);
  });

  test("found at least one Suspense boundary", () => {
    expect(BOUNDARIES.length).toBeGreaterThan(0);
  });

  test("found the notFound() seed and followed it through resolveLocale", () => {
    // The whole point of an import walk rather than a grep: the dominant
    // vector is a helper. If this stops holding, the walk has broken.
    const route = join(SRC, "lib/i18n/route.ts");
    expect(TAINTED.has(route), "lib/i18n/route.ts should be a notFound() seed").toBe(true);
    expect(TAINTED.size).toBeGreaterThan(5);
  });
});

describe("no route that can answer not-found sits behind a Suspense boundary", () => {
  for (const boundary of BOUNDARIES) {
    const key = rel(boundary);
    test(`${key} contains nothing that freezes on flush`, () => {
      const offenders = filesInside(boundary)
        .filter((f) => TAINTED.has(f))
        .map((f) => TAINTED.get(f)!.map(rel).join(" -> "));

      if (ALLOWED[key]) {
        // Staleness: an allowlist entry that no longer describes a violation is
        // a lie about why the rule is being bent, so it fails too.
        expect(
          offenders.length,
          `${key} is allowlisted ("${ALLOWED[key]}") but no longer violates — remove the entry`,
        ).toBeGreaterThan(0);
        return;
      }

      expect(offenders, `${key} has a loading.tsx above code that can call notFound()`).toEqual([]);
    });
  }

  test("the boundary's own layout is deliberately not checked", () => {
    // [lang]/layout.tsx reaches notFound() via resolveLocale and MUST keep
    // doing so — it is what makes an invalid locale a real 404. It renders
    // outside the boundary its own folder's loading.tsx creates, so it must
    // never appear in a violation list.
    const layout = join(APP, "[lang]/layout.tsx");
    expect(TAINTED.has(layout), "sanity: the root layout does reach notFound()").toBe(true);
    for (const b of BOUNDARIES) {
      expect(filesInside(b)).not.toContain(layout);
    }
  });
});

describe("the routes this rule exists to protect", () => {
  // Named explicitly so a future refactor that moves them has to think. These
  // are the five page routes that call notFound() directly, and the reason the
  // boundary above them had to go.
  const MUST_BE_UNBOUNDED = [
    "[lang]/anime/[id]",
    "[lang]/seasonal/[season]/[year]",
    "[lang]/u/[username]",
    "[lang]/u/[username]/followers",
    "[lang]/u/[username]/following",
  ];

  for (const route of MUST_BE_UNBOUNDED) {
    test(`${route} has no Suspense boundary above it`, () => {
      const dir = join(APP, route);
      const covering = BOUNDARIES.filter((b) => dir === b || dir.startsWith(`${b}/`));
      expect(covering.map(rel), `${route} must reach the response unbuffered`).toEqual([]);
    });
  }
});
