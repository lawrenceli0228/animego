package main

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDiffIDs(t *testing.T) {
	prev := map[int]int{1: 10, 2: 20, 3: 30}
	next := map[int]int{1: 10, 3: 31, 4: 40}

	got := DiffIDs(KeyBgm, prev, next)
	want := Diff{
		Added:   []Change{{Key: KeyBgm, ID: 4, To: 40}},
		Removed: []Change{{Key: KeyBgm, ID: 2, From: 20}},
		Changed: []Change{{Key: KeyBgm, ID: 3, From: 30, To: 31}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DiffIDs:\n want %+v\n got  %+v", want, got)
	}
}

func reportFixture(t *testing.T) ReportInput {
	items := loadFixture(t)
	res := BuildMap(items)
	return ReportInput{
		Prev: Map{
			Version: "0.3.230",
			Anilist: map[int]int{154587: 3141, 21: 228},
			Bgm:     map[int]int{400602: 3141, 515759: 3800},
		},
		Next:      Map{Version: "0.3.231", Anilist: res.Anilist, Bgm: res.Bgm},
		Conflicts: res.Conflicts,
		Pages:     PageIndex(items),
		Stats:     res.Stats,
	}
}

func TestRenderReport_SummaryConflictsAndChanges(t *testing.T) {
	out := RenderReport(reportFixture(t))

	for _, want := range []string{
		"| bangumi-data release | 0.3.231 (was 0.3.230) |",
		"| Items linking a Mikan page | 8 of 9 |",
		"| AniList keys | 4 (was 2): +3 / −1 / changed 0 |",
		"| Bangumi keys | 5 (was 2): +3 / −0 / changed 1 |",
		"| Conflicts, left out | AniList 1, Bangumi 1 |",
		"| Items with no AniList link | 2 (reachable by Bangumi id only) |",
		"| Ids skipped as not numeric | 2 |",
		// The conflict names both pages with their titles.
		"| AniList | [21](https://anilist.co/anime/21) | [228](https://mikanani.me/Home/Bangumi/228) ONE PIECE / 海贼王 (1999-10-20)<br>" +
			"[3977](https://mikanani.me/Home/Bangumi/3977) ONE PIECE エルバフ編 / 航海王 埃鲁巴夫篇 (2026-04-05) |",
		"### Conflicts, left out of the map (2)",
		// Bangumi 515759 moved from page 3800 to 3821.
		"| Bangumi | [515759](https://bgm.tv/subject/515759) | [3800](https://mikanani.me/Home/Bangumi/3800) | " +
			"[3821](https://mikanani.me/Home/Bangumi/3821) 葬送のフリーレン(第2期) / 葬送的芙莉莲 第二季 (2026-01-16) |",
		// AniList 21 left the map because it became a conflict.
		"### Removed (1)",
		"| AniList | [21](https://anilist.co/anime/21) | [228](https://mikanani.me/Home/Bangumi/228)",
		"<details><summary>Added (6)</summary>",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("report is missing %q\n---\n%s", want, out)
		}
	}
}

func TestRenderReport_FirstRunHasNoPreviousVersion(t *testing.T) {
	in := reportFixture(t)
	in.Prev = Map{}
	out := RenderReport(in)
	if !strings.Contains(out, "| bangumi-data release | 0.3.231 |") {
		t.Errorf("first run should show the release alone:\n%s", out)
	}
}

// Titles come from upstream: a pipe must not break the table, and "#12" or
// "@name" must not link an issue or ping a user.
func TestRenderReport_EscapesUpstreamText(t *testing.T) {
	in := ReportInput{
		Next:      Map{Version: "0.3.1", Anilist: map[int]int{}, Bgm: map[int]int{}},
		Conflicts: []Conflict{{Key: KeyAnilist, ID: 5, Mikan: []int{7, 8}}},
		Pages: map[int]Page{
			7: {Title: "THE IDOLM@STER | Movie #12"},
			8: {Title: "Plain"},
		},
	}
	out := RenderReport(in)
	if strings.Contains(out, "IDOLM@STER") || strings.Contains(out, "#12") {
		t.Errorf("@ and # must be broken apart:\n%s", out)
	}
	if !strings.Contains(out, `THE IDOLM@`+wordJoiner+`STER \| Movie #`+wordJoiner+`12`) {
		t.Errorf("escaped title missing:\n%s", out)
	}
}

func TestRenderReport_CapsEachTable(t *testing.T) {
	var conflicts []Conflict
	for i := 1; i <= reportRowCap+50; i++ {
		conflicts = append(conflicts, Conflict{Key: KeyBgm, ID: i, Mikan: []int{1, 2}})
	}
	out := RenderReport(ReportInput{Next: Map{Version: "0.3.2"}, Conflicts: conflicts})

	if got := strings.Count(out, "| Bangumi | ["); got != reportRowCap {
		t.Errorf("want %d conflict rows, got %d", reportRowCap, got)
	}
	if !strings.Contains(out, "_…and 50 more not shown._") {
		t.Errorf("the table should say how many rows it left out:\n%s", out)
	}
}

// A refresh that touches everything must still fit a PR body: a cut never
// splits a character, leaves <details> open, or goes unannounced.
func TestRenderReport_StaysUnderThePRBodyLimit(t *testing.T) {
	next := Map{Version: "0.3.2", Anilist: map[int]int{}, Bgm: map[int]int{}}
	pages := map[int]Page{}
	var conflicts []Conflict
	for i := 1; i <= 2000; i++ {
		next.Anilist[i] = i
		next.Bgm[100000+i] = i
		pages[i] = Page{Title: strings.Repeat("長い番組名", 8), Begin: "2026-01-01"}
		conflicts = append(conflicts, Conflict{Key: KeyBgm, ID: 200000 + i, Mikan: []int{i, i + 1}})
	}
	out := RenderReport(ReportInput{Next: next, Conflicts: conflicts, Pages: pages})

	if len(out) > maxReportBytes {
		t.Errorf("report is %d bytes, over %d", len(out), maxReportBytes)
	}
	if !utf8.ValidString(out) {
		t.Error("the cut split a multi-byte character")
	}
	if strings.Count(out, "<details>") != strings.Count(out, "</details>") {
		t.Error("a <details> block was left open")
	}
	if !strings.HasSuffix(out, fmt.Sprintln("_Report cut here: it would exceed the PR body limit._")) {
		t.Error("a cut report must say that it was cut")
	}
}
