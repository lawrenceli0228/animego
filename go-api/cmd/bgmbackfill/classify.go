// Package main — cmd/bgmbackfill
//
// classify.go: pure classification logic for bgm binding audit.
// No DB, no network — safe to unit-test in isolation.
package main

import (
	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
)

// Classification outcomes returned by classify.
const (
	ClassAGREE      = "AGREE"
	ClassREBIND     = "REBIND"
	ClassQUARANTINE = "QUARANTINE"
	ClassHEAL       = "HEAL"
)

// classifyThreshold is the minimum TitleSimilarity score for AGREE when
// both our CN title and a dandanplay title are present.
const classifyThreshold = 0.5

// classify is a pure function: given a db row, the authoritative id-map
// bgm_id (nil = not in map), and dandanplay's Chinese title for the row's
// bgm_id (nil = not found / not fetched), it returns one of:
//
//   - REBIND    — id-map says a *different* subject; our binding is wrong.
//   - AGREE     — id-map confirms our binding (or absence of evidence).
//   - HEAL      — we lack a CN title; dandanplay has one (worth copying).
//   - QUARANTINE — independent source (dandanplay) disagrees; likely wrong subject.
//
// The row's BgmID is guaranteed non-nil by the SQL query
// (WHERE bgm_id IS NOT NULL), but we defensively treat nil as a 0.
func classify(row dbRow, idMapBgm *int32, ddpTitle *string) string {
	rowBgmID := int32(0)
	if row.BgmID != nil {
		rowBgmID = *row.BgmID
	}

	// 1. id-map is authoritative.
	if idMapBgm != nil {
		if *idMapBgm != rowBgmID {
			return ClassREBIND
		}
		return ClassAGREE
	}

	// 2. Not in id-map — use dandanplay as independent signal.
	if ddpTitle == nil {
		// No dandanplay record: absence of evidence is not evidence of error.
		return ClassAGREE
	}

	if row.TitleChinese == nil {
		// We have no CN title; dandanplay has one — flag as HEALable.
		return ClassHEAL
	}

	// Both present: compare CN titles.
	sim := bangumi.TitleSimilarity(*ddpTitle, *row.TitleChinese)
	if sim >= classifyThreshold {
		return ClassAGREE
	}
	return ClassQUARANTINE
}

// dbRow is the minimal projection of a ListBgmBoundForBackfillRow that
// classify needs.  Using a local type keeps classify_test.go free of
// any dbgen dependency.
type dbRow struct {
	AnilistID    int32
	BgmID        *int32
	TitleNative  *string
	TitleRomaji  *string
	TitleEnglish *string
	TitleChinese *string
}
