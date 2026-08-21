package hant

import (
	"reflect"
	"testing"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// Prevents: a column landing in the wrong field.
//
// Six of the ten fields are *string and three pairs of them differ by one
// word -- title_hant / title_hant_source / title_hant_source_hash.  Swap
// any two and the ladder still runs, the report still prints plausible
// tier counts, and the only visible symptom is every row being classified
// stale (or none of them being) on a tool whose whole job is to decide
// which rows to rewrite.  Nothing downstream can catch that, so the
// mapping is asserted field by field here.
func TestRowsFromDBMapsEveryColumn(t *testing.T) {
	in := []dbgen.ListAnimeForHantBackfillRow{{
		AnilistID:                 16498,
		TitleNative:               ptr("進撃の巨人"),
		TitleChinese:              ptr("进击的巨人"),
		DescriptionCn:             ptr("简介。"),
		TitleHant:                 ptr("進擊的巨人"),
		TitleHantSource:           ptr(SrcWikipedia),
		TitleHantSourceHash:       ptr(SourceHash("進擊的巨人")),
		DescriptionHant:           ptr("簡介。"),
		DescriptionHantSource:     ptr(SrcOpenCC),
		DescriptionHantSourceHash: ptr(SourceHash("简介。")),
	}}

	got := RowsFromDB(in, 0)
	want := []Row{{
		AnilistID:       16498,
		TitleNative:     ptr("進撃の巨人"),
		TitleChinese:    ptr("进击的巨人"),
		DescriptionCN:   ptr("简介。"),
		TitleHant:       ptr("進擊的巨人"),
		TitleHantSource: ptr(SrcWikipedia),
		TitleHantHash:   ptr(SourceHash("進擊的巨人")),
		DescHant:        ptr("簡介。"),
		DescHantSource:  ptr(SrcOpenCC),
		DescHantHash:    ptr(SourceHash("简介。")),
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mapping changed a column:\n got %+v\nwant %+v", got[0], want[0])
	}
}

// A NULL column has to stay NULL rather than becoming "".  The ladder
// distinguishes them: a nil title_chinese means the opencc tier has no
// input and the row is left alone, while an empty string that reached
// Convert would propose writing "" over whatever is stored.
func TestRowsFromDBKeepsNullsNil(t *testing.T) {
	got := RowsFromDB([]dbgen.ListAnimeForHantBackfillRow{{AnilistID: 1}}, 0)
	if len(got) != 1 {
		t.Fatalf("got %d rows, want 1", len(got))
	}
	r := got[0]
	for name, p := range map[string]*string{
		"TitleNative":     r.TitleNative,
		"TitleChinese":    r.TitleChinese,
		"DescriptionCN":   r.DescriptionCN,
		"TitleHant":       r.TitleHant,
		"TitleHantSource": r.TitleHantSource,
		"TitleHantHash":   r.TitleHantHash,
		"DescHant":        r.DescHant,
		"DescHantSource":  r.DescHantSource,
		"DescHantHash":    r.DescHantHash,
	} {
		if p != nil {
			t.Errorf("%s = %q, want nil — a NULL column must not become an empty string", name, *p)
		}
	}
}

// --limit is a smoke-run cap applied after the read.  It has to take the
// first N in the query's order, because the caller's report says it
// describes N rows and an arbitrary N would make two runs incomparable.
func TestRowsFromDBLimit(t *testing.T) {
	in := make([]dbgen.ListAnimeForHantBackfillRow, 5)
	for i := range in {
		in[i].AnilistID = int32(i + 1)
	}

	cases := []struct {
		name  string
		limit int
		want  []int32
	}{
		{"zero is the whole table", 0, []int32{1, 2, 3, 4, 5}},
		{"negative is the whole table", -1, []int32{1, 2, 3, 4, 5}},
		{"a limit takes the head", 2, []int32{1, 2}},
		{"a limit past the end is not an error", 99, []int32{1, 2, 3, 4, 5}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got []int32
			for _, r := range RowsFromDB(in, tc.limit) {
				got = append(got, r.AnilistID)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ids = %v, want %v", got, tc.want)
			}
		})
	}
}
