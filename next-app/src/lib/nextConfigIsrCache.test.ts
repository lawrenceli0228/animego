import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Runtime ISR pages must stay in memory. Written to disk, they pile up under
// .next/server/app in the container's writable layer with no limit, and with
// every title, character and person page crawled in three languages they
// filled the server's disk -- the database's disk -- within a day of a
// deploy. next.config.ts says why in full; this pins the two settings.

const file = join(import.meta.dir, "../../next.config.ts");
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Every value assigned to a property with this name, anywhere in the file. */
function assigned(name: string): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) found.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("next.config.ts keeps runtime ISR pages off the disk", () => {
  test("experimental.isrFlushToDisk is false, and set once", () => {
    const values = assigned("isrFlushToDisk");
    expect(values).toHaveLength(1);
    expect(values[0].kind).toBe(ts.SyntaxKind.FalseKeyword);
  });

  test("the in-memory cache is set explicitly, and to more than Next's 50 MB default", () => {
    const values = assigned("cacheMaxMemorySize");
    expect(values).toHaveLength(1);
    // A literal byte count, or a product of literals such as 128 * 1024 * 1024.
    const evaluate = (e: ts.Expression): number => {
      if (ts.isNumericLiteral(e)) return Number(e.text);
      if (ts.isParenthesizedExpression(e)) return evaluate(e.expression);
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
        return evaluate(e.left) * evaluate(e.right);
      }
      throw new Error(`cacheMaxMemorySize is not a constant expression: ${e.getText(source)}`);
    };
    expect(evaluate(values[0])).toBeGreaterThan(50 * 1024 * 1024);
  });
});
