package queue

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type factsWrite struct {
	start, end pgtype.Date
	duration   *int32
	source     *string
	popularity *int32
	isAdult    bool
	malID      *int32
	nextAt     pgtype.Timestamptz
	nextEp     *int32
}

type fakeFactsDB struct {
	candidates []int32
	listErr    error
	updErr     error
	gotStale   pgtype.Interval
	gotLimit   int32
	written    map[int32]factsWrite
	stamped    []int32
	synonyms   map[int32][]string
	synDeletes int
	tags       map[int32][]string
	tagDeletes []string
	links      map[int32][]string
}

func newFakeFactsDB(ids ...int32) *fakeFactsDB {
	return &fakeFactsDB{candidates: ids, written: map[int32]factsWrite{}, synonyms: map[int32][]string{}, tags: map[int32][]string{}, links: map[int32][]string{}}
}

func (f *fakeFactsDB) ListAnimeFactsCandidates(_ context.Context, stale pgtype.Interval, limit int32) ([]int32, error) {
	f.gotStale, f.gotLimit = stale, limit
	return f.candidates, f.listErr
}

func (f *fakeFactsDB) UpdateAnimeFacts(_ context.Context, p dbgen.UpdateAnimeFactsParams) (int64, error) {
	if f.updErr != nil {
		return 0, f.updErr
	}
	f.written[p.AnilistID] = factsWrite{
		start: p.StartDate, end: p.EndDate, duration: p.Duration, source: p.Source,
		popularity: p.Popularity, isAdult: p.IsAdult, malID: p.MalID,
		nextAt: p.NextAiringAt, nextEp: p.NextAiringEpisode,
	}
	return 1, nil
}

func (f *fakeFactsDB) DeleteAnimeSynonyms(_ context.Context, id int32) error {
	f.synDeletes++
	delete(f.synonyms, id)
	return nil
}

func (f *fakeFactsDB) InsertAnimeSynonym(_ context.Context, id int32, syn string) error {
	f.synonyms[id] = append(f.synonyms[id], syn)
	return nil
}

func (f *fakeFactsDB) DeleteAnimeTagsBySource(_ context.Context, id int32, source string) error {
	f.tagDeletes = append(f.tagDeletes, source)
	delete(f.tags, id)
	return nil
}

func (f *fakeFactsDB) InsertAnimeTag(_ context.Context, id int32, source, name string, _ *int32, _ bool) error {
	f.tags[id] = append(f.tags[id], source+":"+name)
	return nil
}

func (f *fakeFactsDB) DeleteAnimeExternalLinks(_ context.Context, id int32) error {
	delete(f.links, id)
	return nil
}

func (f *fakeFactsDB) InsertAnimeExternalLink(_ context.Context, id int32, _ string, url string, _ *string) error {
	f.links[id] = append(f.links[id], url)
	return nil
}

func (f *fakeFactsDB) MarkAnimeFactsChecked(_ context.Context, id int32) (int64, error) {
	f.stamped = append(f.stamped, id)
	return 1, nil
}

type fakeFactsFetcher struct {
	batches [][]int
	respond func(ids []int) (*anilist.MediaFactsResponse, error)
}

func (f *fakeFactsFetcher) Facts(_ context.Context, v anilist.FactsVars) (*anilist.MediaFactsResponse, error) {
	f.batches = append(f.batches, v.IDs)
	return f.respond(v.IDs)
}

func factsJob() *river.Job[AnimeFactsArgs] { return &river.Job[AnimeFactsArgs]{} }

func fullDate(y, m, d int) *anilist.FuzzyDate {
	return &anilist.FuzzyDate{Year: &y, Month: &m, Day: &d}
}

func factsMedia(id int, start, end *anilist.FuzzyDate, duration *int, source *string) anilist.Media {
	return anilist.Media{ID: id, StartDate: start, EndDate: end, Duration: duration, Source: source}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestAnimeFacts_WritesReturnedAndStampsAbsent — the two halves of a
// batch: media AniList returned are written with their facts, ids it
// omitted are stamped so they stop leading the next pass.
func TestAnimeFacts_WritesReturnedAndStampsAbsent(t *testing.T) {
	t.Parallel()

	db := newFakeFactsDB(1, 2, 3)
	src := "MANGA"
	dur := 24
	al := &fakeFactsFetcher{respond: func(ids []int) (*anilist.MediaFactsResponse, error) {
		return &anilist.MediaFactsResponse{Page: anilist.MediaPage{Media: []anilist.Media{
			factsMedia(1, fullDate(2024, 4, 26), fullDate(2024, 7, 12), &dur, &src),
			// 2 is absent: deleted or merged upstream.
			factsMedia(3, &anilist.FuzzyDate{Year: intp(2011)}, nil, nil, nil), // year-only start, nothing else
		}}}, nil
	}}

	require.NoError(t, NewAnimeFactsWorker(al, db).Work(context.Background(), factsJob()))

	require.Len(t, al.batches, 1)
	assert.Equal(t, []int{1, 2, 3}, al.batches[0])

	w1 := db.written[1]
	require.True(t, w1.start.Valid)
	assert.Equal(t, time.Date(2024, 4, 26, 0, 0, 0, 0, time.UTC), w1.start.Time)
	require.True(t, w1.end.Valid)
	assert.Equal(t, time.Date(2024, 7, 12, 0, 0, 0, 0, time.UTC), w1.end.Time)
	require.NotNil(t, w1.duration)
	assert.Equal(t, int32(24), *w1.duration)
	require.NotNil(t, w1.source)
	assert.Equal(t, "MANGA", *w1.source)

	// A year-only date is NULL, not 2011-01-01; the row is still written
	// (and therefore stamped) because the read happened.
	w3, ok := db.written[3]
	require.True(t, ok, "a returned row with partial facts is still a read")
	assert.False(t, w3.start.Valid, "year-only start must not be padded into a date")
	assert.False(t, w3.end.Valid)
	assert.Nil(t, w3.duration)
	assert.Nil(t, w3.source)

	assert.Equal(t, []int32{2}, db.stamped, "the omitted id is stamped, the returned ones are not double-stamped")
}

// TestAnimeFacts_BatchesByPageCap — 120 candidates become three requests
// of 50/50/20, never one of 120 that AniList would silently truncate.
func TestAnimeFacts_BatchesByPageCap(t *testing.T) {
	t.Parallel()

	ids := make([]int32, 120)
	for i := range ids {
		ids[i] = int32(i + 1)
	}
	db := newFakeFactsDB(ids...)
	al := &fakeFactsFetcher{respond: func(ids []int) (*anilist.MediaFactsResponse, error) {
		media := make([]anilist.Media, 0, len(ids))
		for _, id := range ids {
			media = append(media, factsMedia(id, fullDate(2000, 1, 1), nil, nil, nil))
		}
		return &anilist.MediaFactsResponse{Page: anilist.MediaPage{Media: media}}, nil
	}}

	require.NoError(t, NewAnimeFactsWorker(al, db).Work(context.Background(), factsJob()))

	require.Len(t, al.batches, 3)
	assert.Len(t, al.batches[0], 50)
	assert.Len(t, al.batches[1], 50)
	assert.Len(t, al.batches[2], 20)
	assert.Len(t, db.written, 120)
	assert.Empty(t, db.stamped)
	assert.Equal(t, anilistRatingsBatch, db.gotLimit, "the pass cap is the ratings cap: same limiter, same reason")
	assert.Equal(t, int64(factsStaleAfter/time.Microsecond), db.gotStale.Microseconds)
}

// TestAnimeFacts_FailedBatchLeavesRowsUnstamped — an upstream failure
// must not stamp anything: the rows stay candidates for the next pass,
// and the pass itself returns nil so river does not put it on a
// days-long backoff.
func TestAnimeFacts_FailedBatchLeavesRowsUnstamped(t *testing.T) {
	t.Parallel()

	db := newFakeFactsDB(1, 2)
	al := &fakeFactsFetcher{respond: func([]int) (*anilist.MediaFactsResponse, error) {
		return nil, errors.New("anilist: 500")
	}}

	require.NoError(t, NewAnimeFactsWorker(al, db).Work(context.Background(), factsJob()))

	assert.Empty(t, db.written)
	assert.Empty(t, db.stamped)
}

// TestAnimeFacts_NothingDueMakesNoRequest — an empty candidate list is
// the steady state and must cost zero upstream calls.
func TestAnimeFacts_NothingDueMakesNoRequest(t *testing.T) {
	t.Parallel()

	db := newFakeFactsDB()
	al := &fakeFactsFetcher{respond: func([]int) (*anilist.MediaFactsResponse, error) {
		t.Fatal("no request expected")
		return nil, nil
	}}

	require.NoError(t, NewAnimeFactsWorker(al, db).Work(context.Background(), factsJob()))
	assert.Empty(t, al.batches)
}

// TestAnimeFacts_ListFailureIsTheOnlyReturnedError — a pass that cannot
// see its work list has not started, and that is the one case river
// should retry.
func TestAnimeFacts_ListFailureIsTheOnlyReturnedError(t *testing.T) {
	t.Parallel()

	db := newFakeFactsDB()
	db.listErr = errors.New("pg down")
	al := &fakeFactsFetcher{respond: func([]int) (*anilist.MediaFactsResponse, error) { return nil, nil }}

	err := NewAnimeFactsWorker(al, db).Work(context.Background(), factsJob())
	require.Error(t, err)
	assert.ErrorContains(t, err, "list candidates")
}

// TestAnimeFacts_UpdateFailureDoesNotStampOrAbort — one row's write
// failing leaves that row a candidate and does not stop the batch.
func TestAnimeFacts_UpdateFailureDoesNotStampOrAbort(t *testing.T) {
	t.Parallel()

	db := newFakeFactsDB(1, 2)
	db.updErr = errors.New("constraint")
	al := &fakeFactsFetcher{respond: func(ids []int) (*anilist.MediaFactsResponse, error) {
		return &anilist.MediaFactsResponse{Page: anilist.MediaPage{Media: []anilist.Media{
			factsMedia(1, fullDate(2000, 1, 1), nil, nil, nil),
		}}}, nil
	}}

	require.NoError(t, NewAnimeFactsWorker(al, db).Work(context.Background(), factsJob()))
	assert.Empty(t, db.written)
	// 2 was absent upstream and is stamped regardless of 1's write failing.
	assert.Equal(t, []int32{2}, db.stamped)
}

func intp(v int) *int { return &v }

// TestAnimeFacts_ScalarBlockAndSynonyms — the 0036 scalars ride along
// with the four facts, and the synonym set is replaced per returned row.
func TestAnimeFacts_ScalarBlockAndSynonyms(t *testing.T) {
	t.Parallel()

	db := newFakeFactsDB(1, 2)
	db.synonyms[1] = []string{"stale-old-synonym"}
	adult := true
	al := &fakeFactsFetcher{respond: func(ids []int) (*anilist.MediaFactsResponse, error) {
		m1 := factsMedia(1, fullDate(2024, 4, 26), nil, nil, nil)
		m1.Popularity = intp(4242)
		m1.IDMal = intp(99)
		m1.IsAdult = &adult
		m1.NextAiringEpisode = &anilist.NextAiringEpisode{AiringAt: 1_700_000_000, Episode: 3}
		m1.Synonyms = []string{"A", " A ", "", "B"}
		m2 := factsMedia(2, nil, nil, nil, nil) // nothing stated, no synonyms
		return &anilist.MediaFactsResponse{Page: anilist.MediaPage{Media: []anilist.Media{m1, m2}}}, nil
	}}

	require.NoError(t, NewAnimeFactsWorker(al, db).Work(context.Background(), factsJob()))

	w1 := db.written[1]
	assert.Equal(t, int32(4242), *w1.popularity)
	assert.Equal(t, int32(99), *w1.malID)
	assert.True(t, w1.isAdult)
	require.True(t, w1.nextAt.Valid)
	assert.Equal(t, int32(3), *w1.nextEp)
	assert.Equal(t, []string{"A", "B"}, db.synonyms[1], "old set gone, new set trimmed and de-duplicated")

	w2 := db.written[2]
	assert.Nil(t, w2.popularity)
	assert.False(t, w2.isAdult, "this document selects isAdult, so an absent value is false")
	assert.False(t, w2.nextAt.Valid)
	_, has := db.synonyms[2]
	assert.False(t, has, "an empty set is a delete with no inserts")
	assert.Equal(t, 2, db.synDeletes)
}

// TestAnimeFacts_TagsAndLinks — the AniList tag set is replaced under
// its own source (a Bangumi row would survive the delete), external
// links are replaced, and both are cleaned the way the detail path
// cleans them.
func TestAnimeFacts_TagsAndLinks(t *testing.T) {
	t.Parallel()

	db := newFakeFactsDB(1)
	db.tags[1] = []string{"anilist:stale"}
	rank := 87
	social := "SOCIAL"
	al := &fakeFactsFetcher{respond: func(ids []int) (*anilist.MediaFactsResponse, error) {
		m := factsMedia(1, fullDate(2024, 4, 26), nil, nil, nil)
		m.Tags = []anilist.MediaTag{{Name: "Magic", Rank: &rank}, {Name: " Magic "}, {Name: ""}, {Name: "Iyashikei", IsMediaSpoiler: false}}
		m.ExternalLinks = []anilist.ExternalLink{
			{Site: "Official Site", URL: "https://frieren-anime.jp/"},
			{Site: "Twitter", URL: "https://x.com/Anime_Frieren", Type: &social},
			{Site: "junk", URL: "javascript:alert(1)"},
			{Site: "dup", URL: "https://frieren-anime.jp/"},
		}
		return &anilist.MediaFactsResponse{Page: anilist.MediaPage{Media: []anilist.Media{m}}}, nil
	}}

	require.NoError(t, NewAnimeFactsWorker(al, db).Work(context.Background(), factsJob()))

	assert.Equal(t, []string{"anilist"}, db.tagDeletes, "only the anilist source is cleared")
	assert.Equal(t, []string{"anilist:Magic", "anilist:Iyashikei"}, db.tags[1])
	assert.Equal(t, []string{"https://frieren-anime.jp/", "https://x.com/Anime_Frieren"}, db.links[1])
}
