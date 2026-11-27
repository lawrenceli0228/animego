// Package animerelations embeds erengy/anime-relations and answers, for an
// AniList entry, how release groups' continuous numbering is shifted from
// the entry's own.
//
// Fansubs number a season's second cour, or a sequel, by carrying on from
// what came before: Enen no Shouboutai: San no Shou Part 2 ships as "S3 -
// 13" … "S3 - 25" though the entry runs 1–13.  Walking PREQUEL edges and
// summing every earlier season (GetAbsoluteEpisodeOffset) gets franchise-wide
// numbering right and this case wrong: it answers 60, the right shift is 12.
// The anime-relations file is the hand-curated record of these conventions
// that Taiga reads; its rule for this show is
//
//   - 51818|46119|149118:13-25 -> 59229|49016|179062:1-13!
//
// The library identifies a file by hash and binds it to the right entry, so
// what it needs from each rule is only the shift between the numbers on disk
// and the entry's own: 13 − 1 = 12.  The range bounds add nothing it does not
// already check — a shift is only applied when it maps every local number
// into 1..episodes.
//
// The file is in the public domain (CC0).  It is vendored and refreshed by
// .github/workflows/refresh-anime-relations.yml, so prod has no runtime
// dependency on GitHub.
package animerelations

import (
	_ "embed"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

//go:embed anime-relations.txt
var raw []byte

// Relations is the parsed file.  Read-only once built, so safe for
// concurrent use.
type Relations struct {
	shifts       map[int32][]int32
	rules        int
	lastModified string
}

// ruleRe is one rule: "src_ids:range -> dst_ids:range" with an optional
// "!".  Ids are MAL|Kitsu|AniList, each a number, "?" (unknown) or, on the
// destination side, "~" (same as the source).
var ruleRe = regexp.MustCompile(
	`^- ([0-9?]+)\|([0-9?]+)\|([0-9?]+):([0-9]+)(?:-([0-9]+|\?))? -> ([0-9?~]+)\|([0-9?~]+)\|([0-9?~]+):([0-9]+)(?:-([0-9]+|\?))?(!?)$`,
)

// Parse reads the anime-relations format.  A malformed rule is an error
// rather than a skip: the weekly refresh runs this on the new upstream file,
// and a format change should fail that job, not quietly drop rules.
func Parse(data []byte) (*Relations, error) {
	r := &Relations{shifts: map[int32][]int32{}}
	section := ""
	for n, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "" || strings.HasPrefix(line, "#"):
			continue
		case strings.HasPrefix(line, "::"):
			section = strings.TrimPrefix(line, "::")
			continue
		}
		switch section {
		case "meta":
			if v, ok := strings.CutPrefix(line, "- last_modified:"); ok {
				r.lastModified = strings.TrimSpace(v)
			}
		case "rules":
			if err := r.addRule(line); err != nil {
				return nil, fmt.Errorf("animerelations: line %d: %w", n+1, err)
			}
		default:
			return nil, fmt.Errorf("animerelations: line %d: %q outside a section", n+1, line)
		}
	}
	return r, nil
}

func (r *Relations) addRule(line string) error {
	m := ruleRe.FindStringSubmatch(line)
	if m == nil {
		return fmt.Errorf("not a rule: %q", line)
	}
	r.rules++
	srcAnilist, dstAnilist := m[3], m[8]
	if dstAnilist == "~" {
		dstAnilist = srcAnilist
	}
	target, err := strconv.ParseInt(dstAnilist, 10, 32)
	if err != nil || target <= 0 {
		return nil // no AniList id to file it under
	}
	from, err := strconv.ParseInt(m[4], 10, 32)
	if err != nil {
		return fmt.Errorf("source episode %q: %w", m[4], err)
	}
	to, err := strconv.ParseInt(m[9], 10, 32)
	if err != nil {
		return fmt.Errorf("target episode %q: %w", m[9], err)
	}
	shift := int32(from - to)
	if shift == 0 {
		return nil
	}
	id := int32(target)
	for _, s := range r.shifts[id] {
		if s == shift {
			return nil
		}
	}
	r.shifts[id] = append(r.shifts[id], shift)
	return nil
}

// Shifts returns, in file order and without repeats, how much a release
// group's numbering runs ahead of anilistID's own: local − shift is the
// entry's episode.  Nil when the file has no rule for the entry.
func (r *Relations) Shifts(anilistID int32) []int32 {
	s := r.shifts[anilistID]
	if len(s) == 0 {
		return nil
	}
	return append([]int32(nil), s...)
}

// RuleCount is how many rules the file holds, usable or not.
func (r *Relations) RuleCount() int { return r.rules }

// LastModified is the file's own last_modified stamp.
func (r *Relations) LastModified() string { return r.lastModified }

var (
	defaultOnce sync.Once
	defaultRel  *Relations
)

// Default is the embedded file, parsed once.  A parse failure is logged and
// answered with an empty set: the shifts refine numbering, and a server that
// would not start over them would be the worse failure.  The embedded file
// is parsed in this package's tests, so a bad one does not reach a build.
func Default() *Relations {
	defaultOnce.Do(func() {
		rel, err := Parse(raw)
		if err != nil {
			slog.Error("animerelations: embedded file does not parse", "err", err)
			rel = &Relations{shifts: map[int32][]int32{}}
		}
		defaultRel = rel
	})
	return defaultRel
}
