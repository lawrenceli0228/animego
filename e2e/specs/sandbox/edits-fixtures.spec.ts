import { test, expect } from "@playwright/test";
import { closePg, getSql } from "../../fixtures/pg";
import { restoreOverlay, takeOverlay } from "../../fixtures/edits";

// people-edit.spec sets Stark's accepted-edit overlay aside before it runs
// and puts it back after. The sandbox database CI starts from has no overlay
// for Stark, so there the put-back never has anything to write, and a broken
// one only shows on a stack where someone has accepted an edit of Stark.
// This proves the round trip on every run instead, on an overlay of its own:
// an id no page has, so it never meets the edit spec's Stark, whichever
// worker runs what.

const KIND = "character";
const SCRATCH = 2_147_480_001;

test.describe.configure({ mode: "serial" });

const DOC = {
  nameCn: "史塔克",
  aliases: ["斯塔克", "休塔尔克"],
  image: "https://animegoclub.example/api/edit-images/00000000-0000-4000-8000-000000000000.jpg",
  voices: [{ key: "add:95185", personId: 95185, line: "中配" }],
  roles: { "154587": "MAIN" },
};

async function scratchRows() {
  const sql = getSql();
  return sql<{ data: unknown; type: string; updated_at: Date }[]>`
    SELECT data, jsonb_typeof(data) AS type, updated_at
    FROM entity_overlays WHERE kind = ${KIND} AND entity_id = ${SCRATCH}
  `;
}

test.afterAll(async () => {
  await getSql()`DELETE FROM entity_overlays WHERE kind = ${KIND} AND entity_id = ${SCRATCH}`;
  await closePg();
});

test("an overlay set aside comes back as it was", async () => {
  const sql = getSql();
  await sql`DELETE FROM entity_overlays WHERE kind = ${KIND} AND entity_id = ${SCRATCH}`;
  await sql`
    INSERT INTO entity_overlays (kind, entity_id, data, updated_at)
    VALUES (${KIND}, ${SCRATCH}, ${sql.json(DOC)}, '2026-10-01T00:00:00Z')
  `;

  const saved = await takeOverlay(KIND, SCRATCH);
  expect(saved).not.toBeNull();
  expect(await scratchRows(), "set aside").toHaveLength(0);

  // What the spec leaves behind: an overlay of its own accepted edit.
  await sql`INSERT INTO entity_overlays (kind, entity_id, data) VALUES (${KIND}, ${SCRATCH}, ${sql.json({ nameCn: "x" })})`;
  await restoreOverlay(KIND, SCRATCH, saved);

  const rows = await scratchRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.type, "an object, as the table requires").toBe("object");
  expect(rows[0]?.data).toEqual(DOC);
  expect(rows[0]?.updated_at.toISOString(), "and when it was last accepted").toBe("2026-10-01T00:00:00.000Z");
});

test("with nothing set aside, putting back leaves nothing", async () => {
  const sql = getSql();
  await sql`DELETE FROM entity_overlays WHERE kind = ${KIND} AND entity_id = ${SCRATCH}`;
  const saved = await takeOverlay(KIND, SCRATCH);
  expect(saved).toBeNull();

  await sql`INSERT INTO entity_overlays (kind, entity_id, data) VALUES (${KIND}, ${SCRATCH}, ${sql.json({ nameCn: "x" })})`;
  await restoreOverlay(KIND, SCRATCH, saved);
  expect(await scratchRows()).toHaveLength(0);
});
