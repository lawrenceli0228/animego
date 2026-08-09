import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// bun:test runs with no DOM. Some libraries touch `document` while their
// module is still being evaluated — react-hot-toast pulls goober, and goober's
// very first statement reaches for `document.createElement`. A test that
// imports (even transitively) anything on that path dies with
// `ReferenceError: document is not defined` before its first assertion.
//
// The reason this needs a guard rather than a rule in someone's head: bun
// shares ONE process across test files, so whether it explodes depends on
// which file ran first and whether that file happened to leave a `document`
// global behind. Two suites shipped green locally and aborted in CI — 37
// tests and 10 tests, neither of which had ever actually run on the machine
// that approved them.
//
// The fix in both cases was the repo's existing convention: keep the pure
// logic in a module with no React and no DOM, and point the test at that.
// This is the gate that keeps it true. Same spirit as spaDictCoverage — the
// failure it prevents is invisible in local review.

const SRC = import.meta.dir;

/** Packages that evaluate DOM at import time. Add to this list, not around it. */
const DOM_AT_IMPORT = ["react-hot-toast"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|jsx?)$/.test(p) ? [p] : [];
  });
}

const ALL = walk(SRC);
const TEST_FILES = ALL.filter((f) => /\.test\.[tj]sx?$/.test(f));

/** Every `from "…"` specifier in a file, import or re-export alike. */
function specifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

/** Resolve a relative or `@/` specifier to a file on disk, or null. */
function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    base = resolve(dirname(fromFile), spec);
  } else if (spec.startsWith("@/")) {
    base = join(SRC, spec.slice(2));
  } else {
    return null;
  }
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/**
 * Walk a test file's whole local import graph and report the first path that
 * reaches a DOM-at-import package, as "a.ts -> b.tsx -> react-hot-toast".
 */
function offendingPath(entry: string): string | null {
  const seen = new Set<string>([entry]);
  const queue: { file: string; trail: string[] }[] = [
    { file: entry, trail: [relative(SRC, entry)] },
  ];

  while (queue.length) {
    const { file, trail } = queue.shift() as { file: string; trail: string[] };
    for (const spec of specifiers(file)) {
      const hit = DOM_AT_IMPORT.find((p) => spec === p || spec.startsWith(`${p}/`));
      if (hit) return [...trail, hit].join(" -> ");

      const next = resolveLocal(file, spec);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      queue.push({ file: next, trail: [...trail, relative(SRC, next)] });
    }
  }
  return null;
}

describe("test files stay DOM-free", () => {
  test("the walker actually found the suites (guards against a silent no-op)", () => {
    expect(TEST_FILES.length).toBeGreaterThan(30);
  });

  test("no test transitively imports a package that touches document on load", () => {
    const offenders = TEST_FILES.map((f) => offendingPath(f)).filter(
      (p): p is string => p !== null,
    );

    // The message is the whole value of this test: whoever trips it should not
    // have to reproduce a CI-only failure to understand what they did.
    expect(
      offenders,
      offenders.length
        ? `These suites will abort in CI with "document is not defined".\n` +
            `Extract the pure logic into a module with no React/DOM imports and\n` +
            `point the test at that (see subscriptionSetState.ts,\n` +
            `quickSubscribeState.ts).\n\n  ${offenders.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });
});
