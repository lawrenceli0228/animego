-- 0016: single definition of "this row's Bangumi binding is trustworthy enough
-- to copy a synopsis from".
--
-- The test is: does an independent authority agree with the binding we hold?
-- bgm_id_map is refreshed weekly from the vendored AniList->Bangumi map, so a
-- row appearing there with the same pair has been confirmed by something other
-- than our own matcher. bgm_match_source is deliberately NOT the test — that
-- column records how a binding was made, and rows bound before 0011 read NULL
-- even when correct. 'manual' passes because an admin override outranks any
-- automated source.
--
-- Why a view rather than three copies of the predicate: the sweep needs it to
-- pick work, the writer needs it for correctness, and the admin dashboard needs
-- it to report progress. Three hand-copied conditions drift, and when they do
-- the dashboard reports numbers the sweep does not act on — which is worse than
-- having no dashboard, because the wrong number still looks authoritative.
--
-- Postgres inlines a simple view like this into the calling query, so the plans
-- are the same as writing the predicate out longhand.

CREATE OR REPLACE VIEW description_cn_eligible AS
SELECT ac.*
FROM anime_cache ac
WHERE ac.bgm_id IS NOT NULL
  AND (
      ac.bgm_match_source = 'manual'
      OR EXISTS (
          SELECT 1 FROM bgm_id_map m
          WHERE m.anilist_id = ac.anilist_id
            AND m.bgm_id = ac.bgm_id
      )
  );

COMMENT ON VIEW description_cn_eligible IS
  'Rows whose Bangumi binding is independently confirmed (or admin-set), and '
  'are therefore safe to copy a Chinese synopsis from. Single source of truth '
  'for the sweep, the writer, and the admin dashboard — see migration 0016.';
