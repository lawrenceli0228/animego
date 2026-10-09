import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIRRORED_PATH } from "./mirror";

// The image kinds the mirror serves are written down three times: here
// (MIRRORED_PATH, which decides which URLs a page points at the mirror), in
// nginx (which 404s any other path under /img/anilist/), and in go-api's warm
// job (which decides what to have nginx store). If this copy accepts a path
// nginx refuses, every image of that kind on the site turns into a 404, and
// nothing in this app's tests would notice: they run with the switch off. So
// the copies are compared character for character, against the config file
// production runs.

const NGINX_CONF = join(import.meta.dir, "../../../../nginx/default.p9.conf");

/** The allowlist inside each mirror location's regex, keyed by the location's prefix. */
function nginxAllowlists(): Map<string, string> {
  const conf = readFileSync(NGINX_CONF, "utf8");
  const found = new Map<string, string>();
  for (const m of conf.matchAll(/location ~ "\^\/(img\/anilist|warm)\/\(\?<anilist_path>(.+)\)\$" \{/g)) {
    found.set(m[1], m[2]);
  }
  return found;
}

/** MIRRORED_PATH without its anchors, as written (RegExp#source escapes "/"). */
function mirroredPathBody(): string {
  return MIRRORED_PATH.source.replaceAll("\\/", "/").replace(/^\^/, "").replace(/\$$/, "");
}

describe("the mirror's path allowlist matches nginx's", () => {
  test("nginx has both mirror locations, each with an allowlist", () => {
    expect([...nginxAllowlists().keys()].sort()).toEqual(["img/anilist", "warm"]);
  });

  test("/img/anilist/ accepts exactly the paths this app points at it", () => {
    expect(nginxAllowlists().get("img/anilist")).toBe(mirroredPathBody());
  });

  test("the warm location stores exactly the same paths", () => {
    expect(nginxAllowlists().get("warm")).toBe(mirroredPathBody());
  });
});
