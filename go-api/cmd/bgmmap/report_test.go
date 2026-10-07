package main

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestDiffMaps(t *testing.T) {
	prev := []MapEntry{
		{AnilistID: 1, BgmID: 10, Source: "mal"},
		{AnilistID: 2, BgmID: 20, Source: "anidb"},
		{AnilistID: 3, BgmID: 30, Source: "mal"},
	}
	next := []MapEntry{
		{AnilistID: 1, BgmID: 10, Source: "mal"},
		{AnilistID: 3, BgmID: 31, Source: "mal"},
		{AnilistID: 4, BgmID: 40, Source: "mal"},
	}
	got := DiffMaps(prev, next)

	want := MapDiff{
		Added:   []MapEntry{{AnilistID: 4, BgmID: 40, Source: "mal"}},
		Removed: []MapEntry{{AnilistID: 2, BgmID: 20, Source: "anidb"}},
		Changed: []Change{{From: prev[2], To: next[1]}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DiffMaps:\n want %+v\n got  %+v", want, got)
	}
}

// Same subject reached a different way is not a change a reviewer needs to
// read: bgm_id_map consumers only ever compare bgm_id.
func TestDiffMaps_SourceOnlyChangeIsNotAChange(t *testing.T) {
	prev := []MapEntry{{AnilistID: 1, BgmID: 10, Source: "anidb"}}
	next := []MapEntry{{AnilistID: 1, BgmID: 10, MalID: 5, Source: "mal"}}
	if d := DiffMaps(prev, next); len(d.Added)+len(d.Removed)+len(d.Changed) != 0 {
		t.Errorf("want an empty diff, got %+v", d)
	}
}

func reportFixture() ReportInput {
	prev := []MapEntry{
		{AnilistID: 315, BgmID: 15174, Source: "mal"},
		{AnilistID: 144677, BgmID: 390312, Source: "anidb"},
		{AnilistID: 170, BgmID: 3731, Source: "mal"},
	}
	next := []MapEntry{
		{AnilistID: 315, BgmID: 15174, Source: SourceOverride},
		{AnilistID: 144677, BgmID: 367726, Source: "mal"},
		{AnilistID: 999, BgmID: 9999, Source: "mal"},
	}
	return ReportInput{
		Prev: prev,
		Next: next,
		Skips: []Skip{
			{AnilistID: 170, Reason: SkipAmbiguousMal, ViaMal: []int{1608, 3731}, ViaAnidb: []int{1608, 3731}},
			{AnilistID: 315, Reason: SkipMalAnidbDisagree, ViaMal: []int{448690}, ViaAnidb: []int{15174}},
		},
		Overrides: []OverrideOutcome{{
			Override: Override{AnilistID: 315, BgmID: 15174, Note: "1997 film, not the 2024 re-release"},
			JoinSkip: SkipMalAnidbDisagree,
		}},
		Subjects: map[int]Subject{
			15174:  {Name: "小倩", NameCN: "小倩", Date: "1997-07"},
			448690: {Name: "小倩", Date: "2024-12"},
			390312: {Name: "BASTARD!! -暗黒の破壊神- 第2クール", NameCN: "BASTARD！！暗黑破坏神 第二部分", Date: "2022-09"},
			367726: {Name: "BASTARD!! -暗黒の破壊神-", NameCN: "BASTARD！！暗黑破坏神", Date: "2022-06"},
			3731:   {Name: "スラムダンク", Date: "1994-03"},
			1608:   {Name: "SLAM DUNK", Date: "1993-10"},
			9999:   {Name: "New | Show", Date: "2026-10"},
		},
		Stats:       Stats{FribbCount: 100, BelCount: 90, Mapped: 3, Skipped: 2},
		AnidbBefore: 2,
		AnidbAfter:  5,
	}
}

func TestRenderReport_NamesEveryChangeWithItsSubjects(t *testing.T) {
	out := RenderReport(reportFixture())

	for _, want := range []string{
		// changed row: both subjects, by name and link
		"[390312](https://bgm.tv/subject/390312)", "第二部分",
		"[367726](https://bgm.tv/subject/367726)", "BASTARD！！暗黑破坏神",
		"[144677](https://anilist.co/anime/144677)",
		// removed row: the refusal and both candidates
		"[170](https://anilist.co/anime/170)", "several Bangumi subjects share the MAL id",
		"[1608](https://bgm.tv/subject/1608)",
		// added row, with the pipe in its name escaped for the table
		`New \| Show`,
		// override: the pin, what the join said, and the human's reason
		"1997 film, not the 2024 re-release", "MAL and AniDB name different subjects",
		// AniDB pair counts
		"2 → 5",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("report is missing %q\n---\n%s", want, out)
		}
	}
}

func TestRenderReport_CountsMatchSections(t *testing.T) {
	out := RenderReport(reportFixture())
	for _, want := range []string{"### Changed (1)", "### Removed (1)", "Added (1)", "Other refused ids (1)", "### Overrides (1)"} {
		if !strings.Contains(out, want) {
			t.Errorf("report is missing heading %q\n%s", want, out)
		}
	}
}

// A GitHub PR body is capped at 65,536 characters; an upstream outage that
// drops thousands of entries must still produce a body the API accepts.
func TestRenderReport_StaysUnderPRBodyLimit(t *testing.T) {
	in := reportFixture()
	in.Prev = nil
	for i := 1; i <= 20000; i++ {
		in.Prev = append(in.Prev, MapEntry{AnilistID: 100000 + i, BgmID: i, Source: "mal"})
	}
	out := RenderReport(in)

	if len(out) > maxReportBytes {
		t.Errorf("report is %d bytes, over the %d cap", len(out), maxReportBytes)
	}
	if !strings.Contains(out, "not shown") {
		t.Errorf("a truncated section must say so")
	}
	if !strings.Contains(out, fmt.Sprintf("### Removed (%d)", 20000)) {
		t.Errorf("headings must carry the full count even when rows are cut")
	}
}

func TestSubjectIndex(t *testing.T) {
	bel := []BelEntry{
		{BgmID: "1", Name: "A", NameCN: "甲", Date: "2020-01"},
		{BgmID: "", Name: "no id"},
		{BgmID: "x", Name: "bad id"},
	}
	got := SubjectIndex(bel)
	want := map[int]Subject{1: {Name: "A", NameCN: "甲", Date: "2020-01"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("want %+v, got %+v", want, got)
	}
}
