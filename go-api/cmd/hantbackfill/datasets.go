package main

// Loaders for the two vendored human-translation datasets, plus the join
// key normalisation CGroup needs.
//
// See data/hant/README.md for provenance, licences, and the defects each
// dataset carries.  This file's job is to honour those defects in code.

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// ─── anilist-chinese ─────────────────────────────────────────────────────────

// anilistRecord is one row of anilist-chinese.json.  Keyed by AniList id,
// so it joins anime_cache.anilist_id with no fuzzy matching at all -- the
// reason this dataset is the trunk and CGroup is only an overlay.
//
// Synonym order is upstream's and encodes the curator's preference, so
// "the first synonym that passes the gate" is a meaningful pick rather
// than an arbitrary one.
type anilistRecord struct {
	ID       int32    `json:"id"`
	Title    string   `json:"title"`
	Synonyms []string `json:"synonyms,omitempty"`
}

// anilistSet is the loaded dataset indexed by AniList id.
type anilistSet struct {
	byID map[int32]anilistRecord
}

func loadAnilistSet(path string) (*anilistSet, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read anilist-chinese: %w", err)
	}
	var records []anilistRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, fmt.Errorf("parse anilist-chinese: %w", err)
	}
	set := &anilistSet{byID: make(map[int32]anilistRecord, len(records))}
	for _, r := range records {
		if r.ID == 0 {
			return nil, fmt.Errorf("anilist-chinese: record with id 0")
		}
		if _, dup := set.byID[r.ID]; dup {
			return nil, fmt.Errorf("anilist-chinese: duplicate id %d", r.ID)
		}
		set.byID[r.ID] = r
	}
	if len(set.byID) == 0 {
		return nil, fmt.Errorf("anilist-chinese: no records")
	}
	return set, nil
}

// anilistPick is the outcome of asking the dataset for one anime's title.
type anilistPick struct {
	// Value is the accepted string, empty when nothing passed.
	Value string
	// FromSynonym is true when Title was rejected and a synonym stood in.
	FromSynonym bool
	// TitleReason is why the primary Title was rejected, if it was.  It is
	// what the per-rule rejection counts are built from, so it always
	// describes Title and never a synonym.
	TitleReason rejectReason
	// TitleSimplified holds the offending runes when TitleReason is
	// reasonSimplified.  The report emits these so the ~3% of rows that
	// lose a SERP-eligible title this way can be promoted by hand as
	// source='manual'.
	TitleSimplified []rune
}

// pick applies the gate to a record's title, then -- on any rejection --
// to its synonyms in upstream order.
//
// Falling through to synonyms on *every* rejection rather than only on
// "no Han" is deliberate.  The README documents the no-Han case (776 of
// the 1,833 Latin titles have a CJK synonym), but a synonym is an
// alternative name from the same curator regardless of which rule
// dropped the primary, and 13 further rows are rescued by allowing it.
func (s *anilistSet) pick(id int32, g *gate) (anilistPick, bool) {
	rec, ok := s.byID[id]
	if !ok {
		return anilistPick{}, false
	}

	reason, simp := g.check(rec.Title)
	if reason == reasonNone {
		return anilistPick{Value: rec.Title}, true
	}

	out := anilistPick{TitleReason: reason, TitleSimplified: simp}
	for _, syn := range rec.Synonyms {
		if r, _ := g.check(syn); r == reasonNone {
			out.Value = syn
			out.FromSynonym = true
			return out, true
		}
	}
	return out, true
}

// ─── CGroup (Hong Kong overlay) ──────────────────────────────────────────────

// cgroupRecord is one row of cgroup-hk.json: a Hong Kong title plus every
// string in the upstream entry that could serve as a join key -- the
// Japanese original, the Simplified values, the zh-cn/zh-tw/zh-hant
// variants, the conversion source words, and the zh-hk value itself.
type cgroupRecord struct {
	ZhHK string   `json:"zh_hk"`
	Keys []string `json:"keys"`
}

// cgroupSet is the loaded overlay: a normalised key → Hong Kong title
// map with the ambiguous keys already removed.
type cgroupSet struct {
	byKey map[string]string

	// Dropped is the sorted list of normalised keys that mapped to more
	// than one Hong Kong title.  Reported, not resolved.
	Dropped []string
}

// normalizeJoinKey folds a title into the form both sides of the CGroup
// join are compared in.
//
// Three steps, and no more:
//
//	NFKC        so full-width Latin, half-width katakana and the roman
//	            numerals AniList emits (Ⅱ) fold to one representation.
//	lowercase   CGroup writes SOUL EATER, anime_cache writes Soul Eater.
//	drop space  the datasets disagree about spacing around Latin runs and
//	            about U+3000 vs U+0020.
//
// It deliberately does NOT strip punctuation and does NOT strip season
// markers, which is where it parts company with bangumi.NormalizeTitle.
// Punctuation carries identity here (3×3 EYES, .hack//SIGN, Fate/Zero),
// and season markers are load-bearing: 心之谷 is Taiwan's name for
// Whisper of the Heart and Hong Kong's name for its sequel, so a
// normaliser that erases the sequel marker manufactures exactly the
// collision this dataset already has too many of.  Stripping punctuation
// as well was measured: 17 more joins, at the cost of 13 more keys lost
// to fresh collisions.  Not worth it.
func normalizeJoinKey(s string) string {
	s = norm.NFKC.String(s)
	s = strings.ToLower(s)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsSpace(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func loadCgroupSet(path string) (*cgroupSet, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read cgroup-hk: %w", err)
	}
	var records []cgroupRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, fmt.Errorf("parse cgroup-hk: %w", err)
	}
	return buildCgroupSet(records)
}

// buildCgroupSet indexes the records and drops ambiguous keys.
//
// Collisions are detected *after* normalisation, because normalisation
// can create them: two upstream keys differing only in case or spacing
// fold together and may point at different Hong Kong titles.
//
// 17 keys collide in the vendored file and they are genuine upstream
// ambiguity, not parse damage -- ハングリーハート WILD STRIKER has one Hong
// Kong name for the manga and another for the anime; 心之谷 names two
// different films.  Last-write-wins would resolve them by JSON file order,
// which is a coin flip dressed up as a decision.  Ambiguous means no
// answer, so the key is removed from the map entirely and both anime fall
// through to the anilist tier.
func buildCgroupSet(records []cgroupRecord) (*cgroupSet, error) {
	candidates := make(map[string]map[string]struct{})
	for _, rec := range records {
		if rec.ZhHK == "" {
			return nil, fmt.Errorf("cgroup-hk: record with empty zh_hk")
		}
		for _, k := range rec.Keys {
			nk := normalizeJoinKey(k)
			if nk == "" {
				continue
			}
			if candidates[nk] == nil {
				candidates[nk] = make(map[string]struct{})
			}
			candidates[nk][rec.ZhHK] = struct{}{}
		}
	}

	set := &cgroupSet{byKey: make(map[string]string, len(candidates))}
	for nk, values := range candidates {
		if len(values) != 1 {
			set.Dropped = append(set.Dropped, nk)
			continue
		}
		for v := range values {
			set.byKey[nk] = v
		}
	}
	sort.Strings(set.Dropped)

	if len(set.byKey) == 0 {
		return nil, fmt.Errorf("cgroup-hk: no usable keys")
	}
	return set, nil
}

// cgroupHit records which side of the join produced a match, so the
// report can show whether the Japanese-original key is still pulling its
// weight.
type cgroupHit struct {
	Value string
	Via   string // "title_native" or "title_chinese"
}

// lookup tries title_native first, then title_chinese.
//
// Native first because CGroup's first argument is usually the Japanese
// original, and it is measurably the better key: over the 17,511
// production rows it lands 485 normalised hits against title_chinese's
// 405.  Trying it second would hand those rows to whichever key the
// Chinese column happened to match.
func (s *cgroupSet) lookup(titleNative, titleChinese *string) (cgroupHit, bool) {
	for _, side := range []struct {
		val *string
		via string
	}{
		{titleNative, "title_native"},
		{titleChinese, "title_chinese"},
	} {
		if side.val == nil {
			continue
		}
		nk := normalizeJoinKey(*side.val)
		if nk == "" {
			continue
		}
		if v, ok := s.byKey[nk]; ok {
			return cgroupHit{Value: v, Via: side.via}, true
		}
	}
	return cgroupHit{}, false
}
