package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

// SourceOverride marks a map entry a human pinned in overrides.json.
const SourceOverride = "override"

// Override pins one AniList id to a Bangumi subject, whatever the upstream
// join says.  Note is required: an override outranks two community datasets
// every week from now on, and the next reader needs to know why.
type Override struct {
	AnilistID int    `json:"anilist_id"`
	BgmID     int    `json:"bgm_id"`
	Note      string `json:"note"`
}

// OverrideOutcome is an override plus what the join would have said without
// it, so the weekly report can show when upstream has come round to the same
// answer (the override can then go) or still disagrees.
type OverrideOutcome struct {
	Override
	JoinBgmID int        // the join's subject, 0 when it mapped nothing
	JoinSkip  SkipReason // set when the join refused the id
}

// ParseOverrides decodes and validates overrides.json.  Any malformed entry
// fails the whole file: silently dropping a human's correction would hand
// the id back to the upstream answer the human had rejected.
func ParseOverrides(raw []byte) ([]Override, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var ovs []Override
	if err := dec.Decode(&ovs); err != nil {
		return nil, fmt.Errorf("overrides: decode: %w", err)
	}
	// A bad merge can leave two arrays back to back; Decode reads the first
	// and would drop the second without a word.
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("overrides: unexpected data after the list")
	}
	seen := map[int]bool{}
	for i, o := range ovs {
		switch {
		case o.AnilistID <= 0:
			return nil, fmt.Errorf("overrides[%d]: anilist_id must be positive, got %d", i, o.AnilistID)
		case o.BgmID <= 0:
			return nil, fmt.Errorf("overrides[%d] (anilist %d): bgm_id must be positive, got %d", i, o.AnilistID, o.BgmID)
		case strings.TrimSpace(o.Note) == "":
			return nil, fmt.Errorf("overrides[%d] (anilist %d): note is required", i, o.AnilistID)
		case seen[o.AnilistID]:
			return nil, fmt.Errorf("overrides[%d]: anilist_id %d is listed twice", i, o.AnilistID)
		}
		seen[o.AnilistID] = true
	}
	return ovs, nil
}

// ApplyOverrides returns a new entry list with every override in place —
// replacing the join's entry or filling an id the join refused or never
// reached — plus one outcome per override, both sorted by AniList id.  res is
// not modified.
//
// An override carries no MAL or AniDB id: it is a claim about the Bangumi
// subject only, and the AniDB id has its own map (BuildAnidbMap).
func ApplyOverrides(res Result, ovs []Override) ([]MapEntry, []OverrideOutcome) {
	pinned := make(map[int]Override, len(ovs))
	for _, o := range ovs {
		pinned[o.AnilistID] = o
	}
	joined := make(map[int]MapEntry, len(res.Entries))
	entries := make([]MapEntry, 0, len(res.Entries)+len(ovs))
	for _, e := range res.Entries {
		joined[e.AnilistID] = e
		if _, ok := pinned[e.AnilistID]; !ok {
			entries = append(entries, e)
		}
	}
	refused := make(map[int]SkipReason, len(res.Skips))
	for _, s := range res.Skips {
		refused[s.AnilistID] = s.Reason
	}

	outcomes := make([]OverrideOutcome, 0, len(ovs))
	for _, o := range ovs {
		entries = append(entries, MapEntry{AnilistID: o.AnilistID, BgmID: o.BgmID, Source: SourceOverride})
		outcomes = append(outcomes, OverrideOutcome{
			Override:  o,
			JoinBgmID: joined[o.AnilistID].BgmID,
			JoinSkip:  refused[o.AnilistID],
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].AnilistID < entries[j].AnilistID })
	sort.Slice(outcomes, func(i, j int) bool { return outcomes[i].AnilistID < outcomes[j].AnilistID })
	return entries, outcomes
}
