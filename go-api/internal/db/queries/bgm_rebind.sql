-- bgm_rebind.sql — the weekly re-search of airing and upcoming rows that V1
-- could not bind.  The worker is internal/queue/bgm_rebind_search.go; the
-- column is migration 0051, which carries the measurement behind both.
--
-- The sweep never writes a row at bangumi_version 0.  Version 0 is V1's
-- queue, and both of V1's writes are guarded on it alone; a sweep write
-- landing there would race V1 for the same row.  Every statement below
-- carries `bangumi_version > 0` for that reason, not only the candidate read:
-- an admin reset can move a row back to 0 between the read and the write.

-- name: ListBgmRebindCandidates :many
-- Rows the rebind sweep should search Bangumi for again.
--
-- Every clause is a reason a row is NOT the sweep's business:
--
--	bgm_id IS NULL            a bound row has its answer.
--	bangumi_version > 0       version 0 is V1's own queue; the hourly orphan
--	                          scan hands those rows to V1, which searches
--	                          them anyway.
--	status                    RELEASING and NOT_YET_RELEASED only: the shows
--	                          whose Bangumi subject may not exist yet, or may
--	                          not have its final name.  FINISHED, CANCELLED,
--	                          HIATUS and a NULL status are all left out; their
--	                          answer is not going to change week to week, and
--	                          searching the 18k-row back catalogue weekly
--	                          would spend the shared Bangumi bucket on nothing.
--	NOT is_adult              the site lists none of them, and their subjects
--	                          are R18: the legacy search finds them, V2's
--	                          /v0/subjects answers 404 to an anonymous client
--	                          (migration 0031).  A bind would buy nothing.
--	manually-corrected        a human's decision outranks the sweep, the same
--	                          rule BindBgmIdsFromIdMap applies.  An admin who
--	                          unbinds a row must not have it rebound a week
--	                          later by the scorer they were overruling.
--	bgm_id_map entry          the vendored map already names this row's
--	                          subject, and the id-map sweep owns applying it.
--	                          If the row is still unbound, that sweep refused
--	                          on purpose -- the subject is held by another
--	                          row, or a second unbound row claims it -- and a
--	                          fuzzy search must not settle what the map's own
--	                          guard declined to: it would either bind the
--	                          contested subject or bind one the map
--	                          contradicts.  V1 never searches a mapped row
--	                          either; it takes the map's answer.
--	bgm_rebind_checked_at     the weekly cycle.  NULL is "never searched".
--
-- Order: never-searched rows first, the most popular of them first, so a
-- batch cap on the first passes cuts off the long tail and not Edgerunners.
-- After that the stalest stamp leads; stamps are distinct timestamps, so
-- popularity no longer decides anything there.  anilist_id last for a
-- stable order.
SELECT anilist_id,
       title_native,
       title_romaji,
       title_english,
       season_year,
       episodes
FROM anime_cache
WHERE bgm_id IS NULL
  AND bangumi_version > 0
  AND status IN ('RELEASING', 'NOT_YET_RELEASED')
  AND NOT is_adult
  AND admin_flag IS DISTINCT FROM 'manually-corrected'
  AND NOT EXISTS (SELECT 1 FROM bgm_id_map m WHERE m.anilist_id = anime_cache.anilist_id)
  AND (bgm_rebind_checked_at IS NULL
       OR bgm_rebind_checked_at < now() - sqlc.arg(stale_after)::interval)
ORDER BY bgm_rebind_checked_at ASC NULLS FIRST,
         popularity DESC NULLS LAST,
         anilist_id
LIMIT sqlc.arg(lim)::int;

-- name: MarkBgmRebindChecked :execrows
-- Stamp a row the sweep searched and did not bind, so it waits out the cycle.
--
-- Guarded on bgm_id IS NULL: a row bound by another writer between the read
-- and this statement has left the candidate set, and the stamp would only
-- record a search about a binding question that is already settled.  And on
-- bangumi_version > 0, per the file header: a row reset to 0 is about to be
-- searched by V1, and a stamp would hold it back a week if V1 parks it again.
--
-- updated_at is left alone, as MarkBangumiRatingChecked leaves it: the row's
-- content did not change, only when we last asked about it.
UPDATE anime_cache
   SET bgm_rebind_checked_at = now()
 WHERE anilist_id = sqlc.arg(anilist_id)::int
   AND bgm_id IS NULL
   AND bangumi_version > 0;

-- name: BindBgmIdFromRebindSearch :execrows
-- Bind the subject the rebind sweep's search chose.
--
-- The write V1's UpdateBangumiV1 makes, with V1's `bangumi_version = 0`
-- predicate turned around: every candidate has left version 0, which is why
-- the sweep exists, and per the file header the sweep must not write a row
-- that has gone back.  The CAS is `bgm_id IS NULL`, the one
-- BindBgmIdsFromIdMap uses.
--
-- bgm_match_source is 'fuzzy_high' because that is what produced it: V1's
-- keyword, V1's scorer, V1's threshold, over rows the vendored map says
-- nothing about (the candidate query excludes mapped rows, which V1 would
-- have bound from the map without searching).  The sweep's own extra refusal
-- -- a season-marker disagreement -- only ever removes binds.  So a row it
-- binds is one V1 would also have bound had it searched that day, and the
-- admin surface's existing label is accurate for it.
--
-- Rows this sweep bound are told apart by the stamp it sets in the same
-- write: bgm_match_source = 'fuzzy_high' AND bgm_rebind_checked_at IS NOT
-- NULL.  That holds because no version-0 row carries a stamp -- the sweep
-- never writes one, and the three statements that move a row back to 0
-- (ResetAnimeEnrichment, BackfillResetRows, RepudiateLegacyBangumiBinding)
-- clear it with the binding -- and V1, the only other writer of
-- 'fuzzy_high', binds version-0 rows only.
--
-- bangumi_version is left as it is, as BindBgmIdsFromIdMap leaves it.  The
-- V2 job enqueued in the same transaction writes 2 when it completes, which
-- is where a row that has completed V2 belongs.
--
-- title_chinese COALESCEs rather than assigns.  A parked row's is NULL
-- (MarkBangumiNeedsReview and MarkBangumiV1NotFound both clear it), so for
-- the rows this is written for the effect is V1's.  A row that holds one
-- from elsewhere -- an admin edit, a donghua's Chinese native title -- keeps
-- it, which is the rule UpdateBangumiV2 and UpdateBangumiV3 follow.
--
-- admin_flag: a 'needs-review' that V1 raised when it parked the row is
-- answered by this bind, so it is retired -- but only on a row whose
-- bgm_match_source is still 'fuzzy_low', the mark MarkBangumiNeedsReview
-- writes with it.  An admin can set 'needs-review' by hand too
-- (FlagAnimeEnrichment); on any other row the flag is a human's and stays,
-- so the reviewer sees the new binding instead of losing the row from the
-- queue.  'manually-corrected' rows never reach the success path: the
-- predicate below refuses them, as a second line behind the candidate query,
-- because the flag can be set between that read and this write.
--
-- NOT EXISTS is the collision guard: one Bangumi subject describes one work,
-- and a second row bound to it shows the first one's Chinese title, synopsis
-- and episode names.  The worker asks CountAnimeBoundToBgmID first so it can
-- report a collision as one; this clause narrows the race the pre-check
-- leaves.  It does not close it.  Under READ COMMITTED the subquery sees only
-- binds committed before this statement began, so a bind of the same subject
-- that is written but not yet committed is invisible to it.  Against the
-- id-map sweep that cannot happen: both run on the one-slot bgm_bind queue.
-- Against V1, which runs on the default queue, it can: V1's single-statement
-- UPDATE overlapping this bind's transaction (this UPDATE, one river insert,
-- the commit -- milliseconds) with both reaching for the same subject.  That
-- is the exposure V1 already had against the id-map sweep; closing it for
-- every writer at once is the TODOS.md entry on making the database enforce
-- one-subject-one-row.
UPDATE anime_cache AS a
   SET bgm_id                = sqlc.arg(bgm_id)::int,
       title_chinese         = COALESCE(a.title_chinese, sqlc.narg(title_chinese)::text),
       bgm_match_source      = 'fuzzy_high',
       admin_flag            = CASE WHEN a.admin_flag = 'needs-review'
                                     AND a.bgm_match_source = 'fuzzy_low' THEN NULL
                                    ELSE a.admin_flag END,
       bgm_rebind_checked_at = now(),
       updated_at            = now()
 WHERE a.anilist_id = sqlc.arg(anilist_id)::int
   AND a.bgm_id IS NULL
   AND a.bangumi_version > 0
   AND a.admin_flag IS DISTINCT FROM 'manually-corrected'
   AND NOT EXISTS (SELECT 1 FROM anime_cache b
                    WHERE b.bgm_id = sqlc.arg(bgm_id)::int
                      AND b.anilist_id <> a.anilist_id);
