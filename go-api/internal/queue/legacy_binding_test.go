// legacy_binding_test.go — the production rows that show a pre-0011 Bangumi
// binding being republished as another show's data, driven through every
// worker that copies data out of a Bangumi subject.
//
// The six rows are the top of the Fall 2026 seasonal list as it was served on
// 2026-10-06, identity columns copied from anime_cache and subjects copied
// from bgm.tv's /v0/subjects.  Three of them were bound by the matcher that
// took list[0] of a Bangumi search when no result's name equalled the native
// title exactly; Bangumi's search matches any token, so "アオアシ 第2期" came
// back led by アリス探偵局 第2期, a 1996 show sharing nothing but "第2期".
// The other three are correct bindings -- two of them from that same era --
// and must keep being enriched.
package queue

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// Production fixtures
// ---------------------------------------------------------------------------

type legacyBindingCase struct {
	name      string
	anilistID int32
	identity  dbgen.GetBangumiBindingIdentityRow
	subject   *bangumi.Subject
	// anotherWork is the verdict the case exists to pin: true when the bound
	// subject is a different show and nothing from it may be published.
	anotherWork bool
}

func ratedSubject(id int, name, nameCN, date string, score float64, votes int) *bangumi.Subject {
	s := &bangumi.Subject{ID: id, Name: name, NameCN: nameCN, Date: date}
	s.Rating = &struct {
		Score float64 `json:"score"`
		Count int     `json:"total"`
	}{Score: score, Count: votes}
	return s
}

func legacyIdentity(bgmID int32, source *string, native, romaji, english string, seasonYear int32) dbgen.GetBangumiBindingIdentityRow {
	return dbgen.GetBangumiBindingIdentityRow{
		BgmID:          &bgmID,
		BgmMatchSource: source,
		TitleNative:    &native,
		TitleRomaji:    &romaji,
		TitleEnglish:   &english,
		SeasonYear:     &seasonYear,
	}
}

// fall2026TopSix returns fresh copies every call: the workers do not mutate
// their inputs today, and a fixture shared across parallel tests should not
// depend on that staying true.
func fall2026TopSix() []legacyBindingCase {
	fuzzyHigh := "fuzzy_high"
	return []legacyBindingCase{
		{
			name:        "195604 Black Clover 2nd Season bound to ラブライブ! 第2期",
			anilistID:   195604,
			identity:    legacyIdentity(75989, nil, "ブラッククローバー 第2期", "Black Clover 2nd Season", "Black Clover Season 2", 2026),
			subject:     ratedSubject(75989, "ラブライブ! 第2期", "Love Live! 第二季", "2014-04-06", 7.3, 7545),
			anotherWork: true,
		},
		{
			name:        "189123 Ao no Hako Season 2 bound to Vanguard will+Dress Season2",
			anilistID:   189123,
			identity:    legacyIdentity(349389, nil, "アオのハコ Season２", "Ao no Hako Season 2", "Blue Box Season 2", 2026),
			subject:     ratedSubject(349389, "カードファイト!! ヴァンガード will+Dress Season2", "卡片战斗先导者 will+Dress 第二季", "2023-01-14", 5.5, 30),
			anotherWork: true,
		},
		{
			name:        "191788 Aoashi 2nd Season bound to アリス探偵局 第2期",
			anilistID:   191788,
			identity:    legacyIdentity(565999, nil, "アオアシ 第2期", "Aoashi 2nd Season", "Aoashi Season 2", 2026),
			subject:     ratedSubject(565999, "アリス探偵局 第2期", "爱丽丝侦探局 第2期", "1996-04-09", 0, 0),
			anotherWork: true,
		},
		{
			name:      "195516 Kusuriya no Hitorigoto 3rd Season, legacy and correct",
			anilistID: 195516,
			identity:  legacyIdentity(568244, nil, "薬屋のひとりごと 第3期", "Kusuriya no Hitorigoto 3rd Season", "The Apothecary Diaries Season 3", 2026),
			subject:   ratedSubject(568244, "薬屋のひとりごと 第3期", "药屋少女的呢喃 第三季", "2026-10-02", 7.3, 251),
		},
		{
			name:      "210482 JoJo Steel Ball Run 2nd & 3rd STAGE, legacy and correct",
			anilistID: 210482,
			identity: legacyIdentity(639938, nil,
				"ジョジョの奇妙な冒険 スティール・ボール・ラン 2nd＆3rd STAGE",
				"JoJo no Kimyou na Bouken: Steel Ball Run - 2nd & 3rd STAGE",
				"STEEL BALL RUN JoJo's Bizarre Adventure 2nd - 3rd STAGE", 2026),
			subject: ratedSubject(639938, "スティール・ボール・ラン ジョジョの奇妙な冒険 2nd & 3rd STAGE", "飙马野郎 JOJO的奇妙冒险 第二&第三赛段", "2026-09-25", 7.5, 417),
		},
		{
			name:      "213805 Koori no Jouheki 2nd Season, bound by the V1 scorer",
			anilistID: 213805,
			identity:  legacyIdentity(665390, &fuzzyHigh, "氷の城壁 第2期", "Koori no Jouheki 2nd Season", "The Ramparts of Ice Season 2", 2026),
			subject:   ratedSubject(665390, "氷の城壁 第2期", "冰之城墙 第二季", "2026-10-01", 7.3, 249),
		},
	}
}

// ---------------------------------------------------------------------------
// Shared double for the two statements
// ---------------------------------------------------------------------------

type legacyRepudiateCall struct {
	anilistID int32
	bgmID     int32
}

// fakeLegacyBindingDB answers GetBangumiBindingIdentity and records
// RepudiateLegacyBangumiBinding.  Embedded in the V2, V3 and rating-sweep
// doubles so every worker is tested against the same behaviour.
//
// With no identity registered for an id it answers pgx.ErrNoRows, which is
// what every test written before the check expects: no verdict, no change.
type fakeLegacyBindingDB struct {
	legacyMu sync.Mutex

	identities     map[int32]dbgen.GetBangumiBindingIdentityRow
	identityErr    error
	repudiateErr   error
	repudiateRows  *int64
	repudiateCalls []legacyRepudiateCall
}

func (f *fakeLegacyBindingDB) setIdentity(anilistID int32, row dbgen.GetBangumiBindingIdentityRow) {
	f.legacyMu.Lock()
	defer f.legacyMu.Unlock()
	if f.identities == nil {
		f.identities = map[int32]dbgen.GetBangumiBindingIdentityRow{}
	}
	f.identities[anilistID] = row
}

func (f *fakeLegacyBindingDB) GetBangumiBindingIdentity(_ context.Context, anilistID int32) (dbgen.GetBangumiBindingIdentityRow, error) {
	f.legacyMu.Lock()
	defer f.legacyMu.Unlock()
	if f.identityErr != nil {
		return dbgen.GetBangumiBindingIdentityRow{}, f.identityErr
	}
	row, ok := f.identities[anilistID]
	if !ok {
		return dbgen.GetBangumiBindingIdentityRow{}, pgx.ErrNoRows
	}
	return row, nil
}

func (f *fakeLegacyBindingDB) RepudiateLegacyBangumiBinding(_ context.Context, anilistID int32, bgmID int32) (int64, error) {
	f.legacyMu.Lock()
	defer f.legacyMu.Unlock()
	f.repudiateCalls = append(f.repudiateCalls, legacyRepudiateCall{anilistID: anilistID, bgmID: bgmID})
	if f.repudiateErr != nil {
		return 0, f.repudiateErr
	}
	if f.repudiateRows != nil {
		return *f.repudiateRows, nil
	}
	return 1, nil
}

func (f *fakeLegacyBindingDB) snapshotRepudiations() []legacyRepudiateCall {
	f.legacyMu.Lock()
	defer f.legacyMu.Unlock()
	return append([]legacyRepudiateCall(nil), f.repudiateCalls...)
}

// ---------------------------------------------------------------------------
// V2
// ---------------------------------------------------------------------------

// TestBangumiV2_LegacyBindingToAnotherWork is the defect as users saw it: V2
// copies the bound subject's name_cn into title_chinese, its rating into
// bangumi_score, and its episode names onto the page, without asking whether
// the subject is this show.
func TestBangumiV2_LegacyBindingToAnotherWork(t *testing.T) {
	t.Parallel()
	for _, tc := range fall2026TopSix() {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			b := &fakeBangumiV2{
				subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) { return tc.subject, nil },
				episodesFn: func(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
					return &bangumi.EpisodesResponse{Eps: []bangumi.Episode{
						{ID: 1, Type: 0, Sort: 1, Name: "ep1", NameCN: "第一集"},
						{ID: 2, Type: 0, Sort: 2, Name: "ep2", NameCN: "第二集"},
					}}, nil
				},
			}
			tc.subject.Summary = "这是一段足够长的中文简介，用来确认简介也不会从错误的条目里写进来。这是一段足够长的中文简介。"
			tc.subject.Tags = []struct {
				Name  string `json:"name"`
				Count int    `json:"count"`
			}{{Name: "标签", Count: 10}}
			db := &fakeV2DB{}
			db.setIdentity(tc.anilistID, tc.identity)
			enq := &fakeV2Enqueuer{}

			require.NoError(t, runV2WithEnq(t, b, db, enq, int(tc.anilistID), tc.subject.ID))

			if !tc.anotherWork {
				calls := db.snapshotV2Calls()
				require.Len(t, calls, 1, "a correct binding is still enriched")
				require.NotNil(t, calls[0].titleChinese)
				assert.Equal(t, tc.subject.NameCN, *calls[0].titleChinese)
				assert.NotEmpty(t, db.snapshotEpTitleCalls(), "a correct binding still gets its episode names")
				assert.Empty(t, db.snapshotRepudiations(), "a correct binding is never withdrawn")
				return
			}

			assert.Empty(t, db.snapshotV2Calls(),
				"no title_chinese / bangumi_score may be copied from another show's subject")
			assert.Empty(t, db.snapshotEpTitleCalls(), "nor its episode names")
			assert.Empty(t, db.snapshotDescCnCalls(), "nor its synopsis")
			assert.Empty(t, db.snapshotTags(), "nor its tags")
			assert.Empty(t, db.tagDeletes, "and the tag set is not touched either")
			assert.Empty(t, enq.snapshotV3Calls(), "and no heal-CN is chained onto the same subject")
			assert.Equal(t,
				[]legacyRepudiateCall{{anilistID: tc.anilistID, bgmID: int32(tc.subject.ID)}},
				db.snapshotRepudiations(),
				"the binding is withdrawn, pinned to the subject that was fetched")
		})
	}
}

// TestBangumiV2_IdentityReadFailure_RetriesWithoutWriting: a failed read must
// not become a licence to publish -- the same stance the V1 collision check
// takes.
func TestBangumiV2_IdentityReadFailure_RetriesWithoutWriting(t *testing.T) {
	t.Parallel()
	tc := fall2026TopSix()[0]
	b := &fakeBangumiV2{subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) { return tc.subject, nil }}
	db := &fakeV2DB{}
	db.identityErr = assert.AnError

	err := runV2(t, b, db, int(tc.anilistID), tc.subject.ID)

	require.Error(t, err, "river must retry the job")
	assert.ErrorIs(t, err, assert.AnError)
	assert.Empty(t, db.snapshotV2Calls())
	assert.Empty(t, db.snapshotRepudiations())
}

// ---------------------------------------------------------------------------
// V3
// ---------------------------------------------------------------------------

// TestBangumiV3_LegacyBindingToAnotherWork: V3 overwrites title_chinese
// unconditionally, and the admin re-enrich?version=2 path runs it on every
// version-2 row that holds a bgm_id -- which re-publishes a wrong name even
// after someone cleared it by hand.
func TestBangumiV3_LegacyBindingToAnotherWork(t *testing.T) {
	t.Parallel()
	for _, tc := range fall2026TopSix() {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			b := &fakeBangumiV3{subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) { return tc.subject, nil }}
			db := &fakeV3DB{}
			db.setIdentity(tc.anilistID, tc.identity)

			require.NoError(t, runV3(t, b, db, int(tc.anilistID), tc.subject.ID))

			if !tc.anotherWork {
				calls := db.snapshotCalls()
				require.Len(t, calls, 1)
				require.NotNil(t, calls[0].titleChinese)
				assert.Equal(t, tc.subject.NameCN, *calls[0].titleChinese)
				assert.Empty(t, db.snapshotRepudiations())
				return
			}
			assert.Empty(t, db.snapshotCalls(), "no title_chinese from another show's subject")
			assert.Empty(t, db.snapshotDescCnCalls())
			assert.Equal(t,
				[]legacyRepudiateCall{{anilistID: tc.anilistID, bgmID: int32(tc.subject.ID)}},
				db.snapshotRepudiations())
		})
	}
}

// ---------------------------------------------------------------------------
// Bangumi rating sweep
// ---------------------------------------------------------------------------

// TestBangumiRatings_LegacyBindingToAnotherWork: the sweep is the one writer
// that reaches these rows on its own -- it re-reads current-year rows every
// ninety days -- and each pass re-stamped another show's score on them.
func TestBangumiRatings_LegacyBindingToAnotherWork(t *testing.T) {
	t.Parallel()
	cases := fall2026TopSix()
	rows := make([]dbgen.ListBangumiRatingCandidatesRow, 0, len(cases))
	subjects := map[int]*bangumi.Subject{}
	db := newFakeBangumiRatingsDB()
	for _, tc := range cases {
		rows = append(rows, bgmCandidate(tc.anilistID, int32(tc.subject.ID)))
		subjects[tc.subject.ID] = tc.subject
		db.setIdentity(tc.anilistID, tc.identity)
	}
	db.candidates = rows
	fetch := &fakeSubjectFetcher{respond: func(bgmID int) (*bangumi.Subject, error) { return subjects[bgmID], nil }}

	require.NoError(t, NewBangumiRatingsWorker(fetch, db).Work(context.Background(), nil))

	var want []legacyRepudiateCall
	for _, tc := range cases {
		_, written := db.updates[tc.anilistID]
		if tc.anotherWork {
			assert.False(t, written, "%s: another show's rating must not be written", tc.name)
			want = append(want, legacyRepudiateCall{anilistID: tc.anilistID, bgmID: int32(tc.subject.ID)})
		} else {
			assert.True(t, written, "%s: a correct binding's rating is still refreshed", tc.name)
		}
	}
	assert.ElementsMatch(t, want, db.snapshotRepudiations())
}
