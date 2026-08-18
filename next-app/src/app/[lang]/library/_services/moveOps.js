"use client";
// @ts-check
// moveOps — placeholder.
//
// The brief lists `client/src/services/moveOps.js` as one of the files this
// subagent must port, but that source file does NOT exist in the legacy SPA
// (see `find client/src -name 'moveOps*'` — empty). The brief was authored
// against the design doc's anticipated services list; the move primitive
// was never implemented because the dedupe → merge flow covers the
// cross-folder case that "move season → other series" would have addressed.
//
// Leaving this file as an empty module so the brief's manifest entry
// resolves (and so a later phase can drop the real implementation in
// without renaming files). No exports are referenced anywhere in the ported
// Library tree at the time of this commit.
//
// TODO P6 verify: confirm with subagent A/C that no caller imports
// from this module. If something does, port the legacy move helper here
// from wherever it actually lives (search for `moveSeason` / `moveSeasonTo`
// in the broader codebase).

export {};
