// legacy_binding.go — the identity check for Bangumi bindings that nothing has
// ever vouched for.
//
// # The defect
//
// Before migration 0011 the V1 worker searched Bangumi by the native title and,
// when no result's name equalled it exactly, bound list[0].  Bangumi's legacy
// search matches any token, so a sequel queried before its own subject existed
// came back led by an unrelated show that shared nothing but the season suffix:
//
//	ブラッククローバー 第2期  ->  ラブライブ! 第2期                 (2014)
//	アオのハコ Season２        ->  カードファイト!! ヴァンガード will+Dress Season2 (2023)
//	アオアシ 第2期             ->  アリス探偵局 第2期                (1996)
//
// The matcher is long gone; its bindings are not.  They carry no
// bgm_match_source, because the column came with 0011, and every step after V1
// trusted them: V2 copies the subject's name_cn into title_chinese, its rating
// into bangumi_score, its episode list into anime_episode_titles; V3 rewrites
// title_chinese from it; the rating sweep refreshes the score from it every
// quarter.  The result is another show's name on a public, indexed page.
//
// # The check
//
// Every worker that is about to copy data out of a subject it has just
// fetched asks first whether that subject still describes the row, and only
// for bindings nothing has vouched for (no recorded source, no admin
// correction, no id-map entry naming the pair).  A binding made since 0011
// passed a check when it was made -- the id map, or the V1 scorer, which
// compares three AniList titles against the subject's two names with a higher
// floor than this check uses -- so it is not second-guessed here.
//
// The verdict needs TWO independent signals, and both must be present:
//
//   - The subject's own name resembles none of the AniList titles (native,
//     romaji, English) -- season-blind similarity below
//     titlematch.SimilarityFloor.  Never title_chinese: on a mis-bound row it
//     already holds the subject's name_cn, so comparing the two validates the
//     error with the error.
//   - The subject aired at least legacyBindingMinYearGap years away from the
//     AniList entry's year.
//
// Either signal alone has known false positives: a title that only differs by
// script (笑う蜘蛛 / The Laughing Spider), by variant characters, or by
// Bangumi's habit of appending a long subtitle; and dates that differ because
// AniList and Bangumi date a special or a re-release differently.  They do not
// coincide on correct bindings in the measured catalogue, and a missing input
// on either side is no verdict at all.  Season and part numbers are
// deliberately NOT a signal here: titlematch's marker extractor does not yet
// recognise forms like 第2シリーズ or パート2, and reads the III in
// "Lupin III" as a season, so as a trigger for deleting data it would
// withdraw correct bindings.
//
// # The consequence
//
// A binding the check rejects is withdrawn (RepudiateLegacyBangumiBinding)
// together with everything copied out of it, and the row goes back to
// bangumi_version 0, where the hourly orphan scan hands it to V1.  V1 binds
// through the id map or the scorer, both of which record a source, so the row
// cannot come back to this check -- there is no loop.
package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/titlematch"
)

// legacyBindingMinYearGap is how many years apart a subject's air date and the
// AniList entry's year must be before the dates count as disagreeing.  One
// year is not enough: a December premiere filed under the next year's winter
// season is one year off and the same show.
const legacyBindingMinYearGap = 2

// adminFlagManuallyCorrected is the admin_flag value an admin PATCH writes
// (see UpdateAnimeEnrichmentSelective).  A human's decision outranks the check.
const adminFlagManuallyCorrected = "manually-corrected"

// LegacyBindingDB is the two-statement surface the check needs.  V2, V3 and
// the Bangumi rating sweep all embed it in their DB interfaces.
type LegacyBindingDB interface {
	GetBangumiBindingIdentity(ctx context.Context, anilistID int32) (dbgen.GetBangumiBindingIdentityRow, error)
	RepudiateLegacyBangumiBinding(ctx context.Context, anilistID int32, bgmID int32) (int64, error)
}

// legacyBindingNamesAnotherWork reports whether subj -- the subject a worker
// fetched for bgmID -- names a different work than the row it is bound to,
// and why.  Pure: everything it needs is in its arguments.
//
// false means "no verdict" as often as it means "same work": every missing
// input stands the check down, because the consequence of true is deleting
// data and missing evidence is not evidence.
func legacyBindingNamesAnotherWork(id dbgen.GetBangumiBindingIdentityRow, bgmID int32, subj *bangumi.Subject) (bool, string) {
	// A verdict about a subject the row no longer holds is no verdict.
	if id.BgmID == nil || *id.BgmID != bgmID {
		return false, ""
	}
	// Bindings something has vouched for.
	if id.BgmMatchSource != nil || id.IDMapAgrees {
		return false, ""
	}
	if id.AdminFlag != nil && *id.AdminFlag == adminFlagManuallyCorrected {
		return false, ""
	}
	if subj == nil {
		return false, ""
	}
	name := strings.TrimSpace(subj.Name)
	if name == "" {
		return false, ""
	}
	titles := nonEmptyTitles(id.TitleNative, id.TitleRomaji, id.TitleEnglish)
	if len(titles) == 0 {
		return false, ""
	}
	rowYear, ok := anilistYear(id)
	if !ok {
		return false, ""
	}
	subjectYear, ok := bangumiYear(subj.Date)
	if !ok {
		return false, ""
	}
	gap := rowYear - subjectYear
	if gap < 0 {
		gap = -gap
	}
	if gap < legacyBindingMinYearGap {
		return false, ""
	}
	sim := titlematch.BestSimilarity(name, titles...)
	if sim >= titlematch.SimilarityFloor {
		return false, ""
	}
	return true, fmt.Sprintf("title similarity %.2f below %.2f; subject aired %d, AniList year %d",
		sim, titlematch.SimilarityFloor, subjectYear, rowYear)
}

// withdrawIfAnotherWork is the worker-facing half: read the row's binding
// identity, decide, and withdraw the binding when the subject names another
// work.  withdrawn == true means the caller must not write anything taken from
// subj, whatever err says.
//
//   - pgx.ErrNoRows: the row is gone, so there is nothing to protect and the
//     caller's own writes will match nothing.  (false, nil).
//   - any other read error: (false, err).  A failed read must not become a
//     licence to publish; callers retry, the same stance V1's collision check
//     takes.
//   - a failed withdrawal: (true, err).  The verdict stands -- publishing the
//     subject is still wrong -- and the caller retries so the withdrawal runs.
//   - a withdrawal that matched no row: the binding moved between the read and
//     the write.  (true, nil): the subject in hand is still not this row's.
func withdrawIfAnotherWork(ctx context.Context, db LegacyBindingDB, phase string, anilistID, bgmID int32, subj *bangumi.Subject) (bool, error) {
	id, err := db.GetBangumiBindingIdentity(ctx, anilistID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("%s binding identity %d (bgmId=%d): %w", phase, anilistID, bgmID, err)
	}
	another, reason := legacyBindingNamesAnotherWork(id, bgmID, subj)
	if !another {
		return false, nil
	}
	n, err := db.RepudiateLegacyBangumiBinding(ctx, anilistID, bgmID)
	if err != nil {
		return true, fmt.Errorf("%s withdraw legacy binding %d (bgmId=%d): %w", phase, anilistID, bgmID, err)
	}
	slog.WarnContext(ctx, phase+" legacy binding names another work; withdrawn",
		"anilistId", anilistID,
		"bgmId", bgmID,
		"subject", subj.Name,
		"reason", reason,
		"rowsWithdrawn", n)
	return true, nil
}

// nonEmptyTitles keeps the titles that hold something.
func nonEmptyTitles(titles ...*string) []string {
	out := make([]string, 0, len(titles))
	for _, t := range titles {
		if t != nil && strings.TrimSpace(*t) != "" {
			out = append(out, *t)
		}
	}
	return out
}

// anilistYear is the entry's year: season_year, else the year of start_date.
// Same precedence as the /year hub.
func anilistYear(id dbgen.GetBangumiBindingIdentityRow) (int, bool) {
	if id.SeasonYear != nil && *id.SeasonYear > 0 {
		return int(*id.SeasonYear), true
	}
	if id.StartDate.Valid {
		return id.StartDate.Time.Year(), true
	}
	return 0, false
}

// bangumiYear reads the year off a Bangumi date ("2014-04-06").  Bangumi
// writes "0000-00-00" for an unknown date, and anything that is not four
// digits is treated the same way.
func bangumiYear(date string) (int, bool) {
	if len(date) < 4 {
		return 0, false
	}
	y, err := strconv.Atoi(date[:4])
	if err != nil || y <= 0 {
		return 0, false
	}
	return y, true
}
