package main

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestParseOverrides_Valid(t *testing.T) {
	raw := []byte(`[
	  {"anilist_id": 315, "bgm_id": 15174, "note": "1997 film, not the 2024 re-release"},
	  {"anilist_id": 139986, "bgm_id": 360077, "note": "season 5 by air date"}
	]`)
	got, err := ParseOverrides(raw)
	if err != nil {
		t.Fatalf("ParseOverrides: %v", err)
	}
	want := []Override{
		{AnilistID: 315, BgmID: 15174, Note: "1997 film, not the 2024 re-release"},
		{AnilistID: 139986, BgmID: 360077, Note: "season 5 by air date"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("want %+v, got %+v", want, got)
	}
}

func TestParseOverrides_EmptyList(t *testing.T) {
	got, err := ParseOverrides([]byte(`[]`))
	if err != nil || len(got) != 0 {
		t.Errorf("want empty list and no error, got %+v, %v", got, err)
	}
}

// Every override is a human claim that outranks two upstream datasets, so a
// malformed one must stop the run rather than be dropped quietly.
func TestParseOverrides_Rejects(t *testing.T) {
	cases := map[string]string{
		"not json":          `{`,
		"zero anilist id":   `[{"anilist_id": 0, "bgm_id": 1, "note": "x"}]`,
		"zero bgm id":       `[{"anilist_id": 1, "bgm_id": 0, "note": "x"}]`,
		"missing note":      `[{"anilist_id": 1, "bgm_id": 2}]`,
		"blank note":        `[{"anilist_id": 1, "bgm_id": 2, "note": "  "}]`,
		"duplicate anilist": `[{"anilist_id": 1, "bgm_id": 2, "note": "a"}, {"anilist_id": 1, "bgm_id": 3, "note": "b"}]`,
		"unknown field":     `[{"anilist_id": 1, "bgm_id": 2, "note": "a", "bgm": 3}]`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseOverrides([]byte(raw)); err == nil {
				t.Errorf("want an error for %s", raw)
			}
		})
	}
}

func TestApplyOverrides(t *testing.T) {
	res := Result{
		Entries: []MapEntry{
			{AnilistID: 1, BgmID: 10, MalID: 100, AnidbID: 1000, Source: "mal"},
			{AnilistID: 3, BgmID: 30, Source: "anidb", AnidbID: 3000},
		},
		Skips: []Skip{{AnilistID: 2, Reason: SkipMalAnidbDisagree, ViaMal: []int{21}, ViaAnidb: []int{22}}},
	}
	before := append([]MapEntry(nil), res.Entries...)
	ovs := []Override{
		{AnilistID: 3, BgmID: 31, Note: "replace"},
		{AnilistID: 2, BgmID: 22, Note: "settle a refusal"},
		{AnilistID: 4, BgmID: 40, Note: "nothing upstream"},
	}

	entries, outcomes := ApplyOverrides(res, ovs)

	wantEntries := []MapEntry{
		{AnilistID: 1, BgmID: 10, MalID: 100, AnidbID: 1000, Source: "mal"},
		{AnilistID: 2, BgmID: 22, Source: SourceOverride},
		{AnilistID: 3, BgmID: 31, Source: SourceOverride},
		{AnilistID: 4, BgmID: 40, Source: SourceOverride},
	}
	if !reflect.DeepEqual(entries, wantEntries) {
		t.Errorf("entries:\n want %+v\n got  %+v", wantEntries, entries)
	}
	if !reflect.DeepEqual(res.Entries, before) {
		t.Errorf("ApplyOverrides mutated its input: %+v", res.Entries)
	}

	wantOutcomes := []OverrideOutcome{
		{Override: ovs[1], JoinSkip: SkipMalAnidbDisagree},
		{Override: ovs[0], JoinBgmID: 30},
		{Override: ovs[2]},
	}
	if !reflect.DeepEqual(outcomes, wantOutcomes) {
		t.Errorf("outcomes:\n want %+v\n got  %+v", wantOutcomes, outcomes)
	}
}

// The checked-in overrides file is read by every weekly refresh, so a typo
// there must fail this package's tests, not the Monday cron.
func TestCheckedInOverridesParse(t *testing.T) {
	raw, err := os.ReadFile("overrides.json")
	if err != nil {
		t.Fatalf("read overrides.json: %v", err)
	}
	ovs, err := ParseOverrides(raw)
	if err != nil {
		t.Fatalf("overrides.json: %v", err)
	}
	for _, o := range ovs {
		if strings.TrimSpace(o.Note) == "" {
			t.Errorf("override %d has no note", o.AnilistID)
		}
	}
}
