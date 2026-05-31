package main

import (
	"testing"
)

func strPtr(s string) *string { return &s }
func i32Ptr(n int32) *int32   { return &n }

func TestClassify(t *testing.T) {
	t.Parallel()

	bgm100 := i32Ptr(100)
	bgm200 := i32Ptr(200)

	tests := []struct {
		name      string
		row       dbRow
		idMapBgm  *int32
		ddpTitle  *string
		wantClass string
	}{
		// ── id-map cases ────────────────────────────────────────────────
		{
			name:      "REBIND: id-map says different subject",
			row:       dbRow{AnilistID: 1, BgmID: bgm100},
			idMapBgm:  bgm200, // map says 200, we have 100 → wrong
			ddpTitle:  nil,
			wantClass: ClassREBIND,
		},
		{
			name:      "AGREE: id-map confirms our binding",
			row:       dbRow{AnilistID: 2, BgmID: bgm100},
			idMapBgm:  bgm100,
			ddpTitle:  nil,
			wantClass: ClassAGREE,
		},
		{
			name:      "AGREE: id-map confirms even when ddpTitle present",
			row:       dbRow{AnilistID: 3, BgmID: bgm100, TitleChinese: strPtr("进击的巨人")},
			idMapBgm:  bgm100,
			ddpTitle:  strPtr("完全不同的作品"),
			wantClass: ClassAGREE,
		},
		{
			name:      "REBIND: id-map disagrees even when ddpTitle matches our cn",
			row:       dbRow{AnilistID: 4, BgmID: bgm100, TitleChinese: strPtr("进击的巨人")},
			idMapBgm:  bgm200,
			ddpTitle:  strPtr("进击的巨人"),
			wantClass: ClassREBIND,
		},

		// ── no id-map cases ──────────────────────────────────────────────
		{
			name:      "AGREE: not in map, dandanplay has no record",
			row:       dbRow{AnilistID: 5, BgmID: bgm100},
			idMapBgm:  nil,
			ddpTitle:  nil,
			wantClass: ClassAGREE,
		},
		{
			name:      "HEAL: not in map, we lack CN title but ddp has one",
			row:       dbRow{AnilistID: 6, BgmID: bgm100, TitleChinese: nil},
			idMapBgm:  nil,
			ddpTitle:  strPtr("进击的巨人"),
			wantClass: ClassHEAL,
		},
		{
			name: "AGREE: not in map, CN titles are very similar (above threshold)",
			row: dbRow{
				AnilistID:    7,
				BgmID:        bgm100,
				TitleChinese: strPtr("进击的巨人"),
			},
			idMapBgm:  nil,
			ddpTitle:  strPtr("进击的巨人"), // identical → sim=1.0
			wantClass: ClassAGREE,
		},
		{
			name: "QUARANTINE: not in map, CN titles are different (below threshold)",
			row: dbRow{
				AnilistID:    8,
				BgmID:        bgm100,
				TitleChinese: strPtr("进击的巨人"),
			},
			idMapBgm:  nil,
			ddpTitle:  strPtr("鬼灭之刃"), // completely different show
			wantClass: ClassQUARANTINE,
		},

		// ── boundary / edge cases ────────────────────────────────────────
		{
			name: "AGREE: similarity exactly at threshold 0.5",
			// Use titles that are similar enough to yield sim >= 0.5.
			// "进击的巨人第二季" vs "进击的巨人" share most bigrams.
			// Rather than hard-coding an exact float, we use a known-above pair.
			row: dbRow{
				AnilistID:    9,
				BgmID:        bgm100,
				TitleChinese: strPtr("进击的巨人第二季"),
			},
			idMapBgm:  nil,
			ddpTitle:  strPtr("进击的巨人第2季"),
			wantClass: ClassAGREE, // normalisation + bigrams → still above 0.5
		},
		{
			name: "QUARANTINE: clearly below threshold",
			row: dbRow{
				AnilistID:    10,
				BgmID:        bgm100,
				TitleChinese: strPtr("我的英雄学院"),
			},
			idMapBgm:  nil,
			ddpTitle:  strPtr("银魂"), // unrelated
			wantClass: ClassQUARANTINE,
		},
		{
			name:      "AGREE: nil BgmID treated as 0, id-map also 0 → confirm",
			row:       dbRow{AnilistID: 11, BgmID: nil},
			idMapBgm:  i32Ptr(0),
			ddpTitle:  nil,
			wantClass: ClassAGREE,
		},
		{
			name:      "REBIND: nil BgmID treated as 0, id-map says non-zero",
			row:       dbRow{AnilistID: 12, BgmID: nil},
			idMapBgm:  bgm100,
			ddpTitle:  nil,
			wantClass: ClassREBIND,
		},
		{
			name: "HEAL: empty-string TitleChinese is not nil — compares, probably quarantines",
			// An empty-string pointer is not nil; similarity will be low.
			row: dbRow{
				AnilistID:    13,
				BgmID:        bgm100,
				TitleChinese: strPtr(""),
			},
			idMapBgm:  nil,
			ddpTitle:  strPtr("某动画"),
			wantClass: ClassQUARANTINE, // empty normalized → 0 bigrams → sim=0.0 < 0.5
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := classify(tc.row, tc.idMapBgm, tc.ddpTitle)
			if got != tc.wantClass {
				t.Errorf("classify() = %q, want %q", got, tc.wantClass)
			}
		})
	}
}
