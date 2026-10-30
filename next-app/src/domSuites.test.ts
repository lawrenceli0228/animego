import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Runs every DOM suite (`*.dom.tsx`) in a bun process of its own.
//
// Those suites mount real components with React DOM in a jsdom document
// (lib/test-utils/dom.ts) — the only way to see effects, focus and
// superseded requests, which renderToStaticMarkup never runs. They cannot
// share this process:
//
//   - bun runs every test file in one process with one module cache, and the
//     rest of the suite is written for no DOM at all (testImportHygiene.test.ts):
//     a `window` left behind changes what other files render.
//   - Modules decide things once, as they load: next/dynamic whether it is on
//     a server, React DOM which input events exist. Whichever file loaded them
//     first would decide for every other file.
//   - The suites stub modules with mock.module, which is process-wide: a stub
//     of the admin actions here would replace the module that
//     _actions/users.test.ts is testing.
//
// So each suite gets a fresh process, started together and awaited one test
// each; a failure prints the child's own report.

const SRC = import.meta.dir;
const APP = dirname(SRC);
/** jsdom and React DOM take a few seconds to load in a cold process on a CI runner. */
const SUITE_TIMEOUT_MS = 120_000;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.dom\.tsx?$/.test(name) ? [p] : [];
  });
}

const SUITES = walk(SRC).sort();

interface Outcome {
  code: number;
  output: string;
}

// The child's report is read for its pass count, so it must be plain text:
// bun colours it under FORCE_COLOR even through a pipe, and NO_COLOR does not
// override that. Escape codes are stripped as well, whatever else asks for them.
const PLAIN_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "FORCE_COLOR")),
  NO_COLOR: "1",
};
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

async function run(file: string): Promise<Outcome> {
  const child = Bun.spawn([process.execPath, "test", file], {
    cwd: APP,
    env: PLAIN_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}\n${stderr}`.replace(ANSI, "") };
}

const outcomes = new Map<string, Promise<Outcome>>();

beforeAll(() => {
  for (const file of SUITES) outcomes.set(file, run(file));
});

describe("DOM suites, each in its own process", () => {
  test("the walker found them (guards against a silent no-op)", () => {
    expect(SUITES.length).toBeGreaterThan(0);
  });

  for (const file of SUITES) {
    const name = relative(SRC, file);
    test(
      name,
      async () => {
        const outcome = await (outcomes.get(file) ?? run(file));
        const passed = /^\s*(\d+) pass$/m.exec(outcome.output);
        expect(outcome.code, `${name} failed:\n${outcome.output}`).toBe(0);
        expect(Number(passed?.[1] ?? 0), `${name} ran no tests:\n${outcome.output}`).toBeGreaterThan(0);
      },
      SUITE_TIMEOUT_MS,
    );
  }
});
