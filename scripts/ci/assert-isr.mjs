#!/usr/bin/env node
/**
 * CI gate: the anime detail route must stay prerendered / ISR (Next's `●`) and
 * must never silently degrade to pure dynamic (`ƒ`).
 *
 * The stake is the Cloudflare edge cache. The rule that serves /anime/* from
 * the edge only ever gets a cacheable response because this route prerenders;
 * if it turns dynamic the edge hit rate goes to zero, TTFB regresses, and
 * nothing about the page looks broken. That is a silent failure on the site's
 * single most important surface — /anime/* is the whole SEO surface — so it
 * gets a machine check.
 *
 * ## Why a manifest and not the build output
 *
 * The obvious gate is `bun run build | grep -q '● /anime/\[id\]'`. Do not use
 * it. Measured on this repo: adding `export const dynamic = "force-dynamic"`
 * to the route produced a build whose route table was BYTE-IDENTICAL — still
 * `● /anime/[id]`, no warning, exit 0 — while
 * `prerender-manifest.json -> dynamicRoutes` went completely empty. The `●`
 * symbol is chosen from "does this route export generateStaticParams", not
 * from whether anything is actually cacheable. So a stdout grep returns a
 * false GREEN on the single most likely way this regresses.
 *
 * It is also about to break for an unrelated reason: the route becomes
 * `/[lang]/anime/[id]` under the locale migration, so this matches by path
 * SUFFIX rather than exact string.
 *
 * ## The contract
 *
 * From Next's own build code (next/dist/build/index.js writing
 * `prerenderManifest.dynamicRoutes[route.pathname]`, and next/dist/lib/fallback.js
 * mapping FallbackMode to the `fallback` field):
 *
 *   .next/prerender-manifest.json -> dynamicRoutes["<route>"]
 *     present             => prerenderable            => `●`
 *     absent              => server-rendered on demand => `ƒ`
 *     .fallback === null  => BLOCKING_STATIC_RENDER (dynamicParams: true):
 *                            unknown ids render and cache on first request
 *     .fallback === false => NOT_FOUND (dynamicParams: false):
 *                            unknown ids 404 instead of rendering
 *
 * This holds with ZERO pages prerendered, which is the CI case — no Go API is
 * reachable from a runner, so generateStaticParams catches and returns []. The
 * dynamicRoutes entry comes from the route's eligibility, not from the params
 * list. Verified against a real cold build.
 *
 * The other manifests cannot do this job. `routes-manifest.json -> dynamicRoutes`
 * lists all seven dynamic routes including the `force-dynamic` ones — it is a
 * URL-pattern table with no rendering mode, so asserting on it is a permanent
 * false green. `app-path-routes-manifest.json` is a route registry, used below
 * only to answer "does this route still exist". `.next/server/app/<route>.meta`
 * is written only for pages that actually prerendered, so it does not exist here.
 *
 * Not covered: the revalidate WINDOW (60s). With zero pages prerendered it
 * survives only inside minified page.js and is not machine-assertable from any
 * manifest. This gate covers `●` vs `ƒ` only.
 *
 * Exit 0 = ISR-capable. Exit 1 = regression, or cannot verify (fails closed).
 *
 * Usage:
 *   node scripts/ci/assert-isr.mjs [--dist <path/to/.next>] [--route-suffix "/anime/[id]"]
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_ROUTE_SUFFIX = "/anime/[id]";

// Where .next lives, tried in order, when --dist / NEXT_DIST_DIR are absent.
const DIST_CANDIDATES = [".next", "next-app/.next"];

function parseArgs(argv) {
  const args = { dist: process.env.NEXT_DIST_DIR ?? null, suffix: DEFAULT_ROUTE_SUFFIX };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dist") {
      args.dist = argv[i + 1];
      i += 1;
    } else if (flag === "--route-suffix") {
      args.suffix = argv[i + 1];
      i += 1;
    } else {
      return { error: `unknown argument: ${flag}` };
    }
  }
  if (!args.suffix) return { error: "--route-suffix requires a value" };
  return args;
}

function resolveDist(explicit) {
  if (explicit) return resolve(explicit);
  const found = DIST_CANDIDATES.map((candidate) => resolve(candidate)).find((path) => existsSync(path));
  return found ?? resolve(DIST_CANDIDATES[0]);
}

function readManifest(dist, name) {
  const path = join(dist, name);
  if (!existsSync(path)) throw new Error(`missing ${path} — run \`next build\` first`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`could not parse ${path}: ${err.message}`);
  }
}

function fail(message, detail) {
  console.error(`\nFAIL  ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) fail(args.error);

  const dist = resolveDist(args.dist);
  const suffix = args.suffix;

  let appPaths, prerender;
  try {
    // Authoritative "which app routes exist". Values are URL paths with route
    // groups already stripped, so `(marketing)/anime/[id]/page` yields
    // `/anime/[id]`.
    appPaths = readManifest(dist, "app-path-routes-manifest.json");
    prerender = readManifest(dist, "prerender-manifest.json");
  } catch (err) {
    fail(err.message);
  }

  console.log(`ISR gate: routes ending with "${suffix}"`);
  console.log(`  dist: ${dist}`);

  // 1. Does the route still exist? A rename has to turn CI red rather than
  //    quietly pass on zero matches — that is how a gate rots into decoration.
  const knownRoutes = [...new Set(Object.values(appPaths))].sort();
  const matches = knownRoutes.filter((route) => route === suffix || route.endsWith(suffix));

  if (matches.length === 0) {
    fail(
      `no app route ends with "${suffix}".`,
      `  The route was renamed, moved, or deleted — this gate can no longer\n` +
        `  verify anything, so it fails closed. Update --route-suffix.\n` +
        `  Known app routes:\n` +
        knownRoutes.map((route) => `    ${route}`).join("\n"),
    );
  }

  console.log(`  matched: ${matches.join(", ")}`);

  // 2. Every matched route must be prerenderable.
  const dynamicRoutes = prerender?.dynamicRoutes ?? {};
  const problems = [];

  for (const route of matches) {
    const entry = dynamicRoutes[route];

    if (!entry) {
      problems.push(
        `  ${route}\n` +
          `      absent from prerender-manifest.json -> dynamicRoutes\n` +
          `      => Next rendered it as \`ƒ Dynamic\` (server-rendered on demand),\n` +
          `      so Cloudflare has nothing cacheable to hold at the edge.\n` +
          `      Usual causes: \`export const dynamic = "force-dynamic"\`;\n` +
          `      generateStaticParams removed; or a cookies()/headers() read that\n` +
          `      forced the segment dynamic. NOTE: \`export const revalidate\` alone\n` +
          `      does NOT keep a [param] route prerendered — it is ignored without\n` +
          `      generateStaticParams. /seasonal/[season]/[year] is the live example.`,
      );
      continue;
    }

    // 3. fallback === false means dynamicParams: false. The route still counts
    //    as prerendered, but any id outside the build-time list 404s instead of
    //    rendering on demand — and in CI that list is empty, so this would 404
    //    the entire route while still looking healthy.
    if (entry.fallback === false) {
      problems.push(
        `  ${route}\n` +
          `      fallback === false (FallbackMode.NOT_FOUND, i.e. dynamicParams: false)\n` +
          `      => ids outside generateStaticParams() 404 instead of ISR-on-demand.\n` +
          `      Restore \`export const dynamicParams = true\`.`,
      );
      continue;
    }

    const mode =
      entry.fallback === null ? "blocking (dynamicParams: true)" : `prerendered shell (${entry.fallback})`;
    const ppr = entry.experimentalPPR ? " [PPR]" : "";
    console.log(`  OK  ${route} — prerenderable, fallback: ${mode}${ppr}`);
  }

  if (problems.length > 0) {
    fail(`${problems.length} route(s) are not ISR-capable:`, problems.join("\n\n"));
  }

  // Informational only. In CI the backend is unreachable, generateStaticParams
  // returns [], and 0 is the correct answer — never gate on this number.
  const prerenderedCount = Object.keys(prerender?.routes ?? {}).filter((path) =>
    matches.some((match) => new RegExp(`^${match.replace(/\[[^\]]+\]/g, "[^/]+")}$`).test(path)),
  ).length;
  console.log(`  info: ${prerenderedCount} page(s) prerendered at build time (0 is expected without a backend)`);

  console.log("\nPASS  anime detail route is prerendered / ISR-capable.");
  process.exit(0);
}

main();
