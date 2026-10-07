package main

import (
	"fmt"
	"strings"
)

// maxReportBytes keeps the report under GitHub's 65,536-character PR body
// limit with room to spare; past it the create-pull-request step fails and
// the refresh opens no PR at all.
const maxReportBytes = 60000

// reportRowCap bounds each table.  A normal week changes a few dozen rows;
// thousands means an upstream outage, and the counts say that on their own.
const reportRowCap = 150

// reportReasonOrder fixes the order reason counts are listed in.
var reportReasonOrder = []SkipReason{SkipMalAnidbDisagree, SkipAmbiguousMal, SkipAmbiguousAnidb, SkipFribbRowsDisagree}

// Subject is the little of a Bangumi subject a reviewer needs to recognise it.
type Subject struct {
	Name   string
	NameCN string
	Date   string
}

// SubjectIndex collects subject names from BangumiExtLinker for the report.
func SubjectIndex(bel []BelEntry) map[int]Subject {
	out := make(map[int]Subject, len(bel))
	for _, e := range bel {
		if bgm := mustInt(e.BgmID); bgm != 0 {
			out[bgm] = Subject{Name: e.Name, NameCN: e.NameCN, Date: e.Date}
		}
	}
	return out
}

// Change is one AniList id whose Bangumi subject moved.
type Change struct {
	From MapEntry
	To   MapEntry
}

// MapDiff is what a refresh does to the vendored map, by AniList id.
type MapDiff struct {
	Added   []MapEntry
	Removed []MapEntry
	Changed []Change
}

// DiffMaps compares two maps by AniList id.  Only bgm_id counts as a change:
// every consumer of bgm_id_map compares bgm_id, so a subject reached by a
// different path is the same answer.  Both inputs must be sorted.
func DiffMaps(prev, next []MapEntry) MapDiff {
	before := make(map[int]MapEntry, len(prev))
	for _, e := range prev {
		before[e.AnilistID] = e
	}
	d := MapDiff{}
	seen := make(map[int]bool, len(next))
	for _, e := range next {
		seen[e.AnilistID] = true
		old, ok := before[e.AnilistID]
		switch {
		case !ok:
			d.Added = append(d.Added, e)
		case old.BgmID != e.BgmID:
			d.Changed = append(d.Changed, Change{From: old, To: e})
		}
	}
	for _, e := range prev {
		if !seen[e.AnilistID] {
			d.Removed = append(d.Removed, e)
		}
	}
	return d
}

// ReportInput is everything the weekly PR body is built from.
type ReportInput struct {
	Prev        []MapEntry // the vendored map before this run
	Next        []MapEntry // the map this run writes, overrides applied
	Skips       []Skip
	Overrides   []OverrideOutcome
	Subjects    map[int]Subject
	Stats       Stats
	AnidbBefore int
	AnidbAfter  int
}

// RenderReport writes the refresh PR's body: what changed, why ids were
// refused, and what the overrides are holding.
func RenderReport(in ReportInput) string {
	d := DiffMaps(in.Prev, in.Next)
	skips := make(map[int]Skip, len(in.Skips))
	for _, s := range in.Skips {
		skips[s.AnilistID] = s
	}
	r := reportWriter{subjects: in.Subjects}

	r.intro()
	r.summary(in, d)
	r.table(fmt.Sprintf("### Changed (%d)", len(d.Changed)), "| AniList | Before | After | Via |", len(d.Changed), func(i int) string {
		c := d.Changed[i]
		return row(anilistLink(c.From.AnilistID), r.subject(c.From.BgmID), r.subject(c.To.BgmID), c.To.Source)
	})
	r.table(fmt.Sprintf("### Removed (%d)", len(d.Removed)), "| AniList | Was | Why |", len(d.Removed), func(i int) string {
		e := d.Removed[i]
		return row(anilistLink(e.AnilistID), r.subject(e.BgmID), r.removalWhy(skips, e))
	})
	r.details(fmt.Sprintf("Added (%d)", len(d.Added)), "| AniList | Subject | Via |", len(d.Added), func(i int) string {
		e := d.Added[i]
		return row(anilistLink(e.AnilistID), r.subject(e.BgmID), e.Source)
	})
	other := otherRefusals(in.Skips, d.Removed)
	r.details(fmt.Sprintf("Other refused ids (%d)", len(other)), "| AniList | Why | Via MAL | Via AniDB |", len(other), func(i int) string {
		s := other[i]
		return row(anilistLink(s.AnilistID), reasonText(s.Reason), r.subjectList(s.ViaMal), r.subjectList(s.ViaAnidb))
	})
	r.table(fmt.Sprintf("### Overrides (%d)", len(in.Overrides)), "| AniList | Pinned to | Join says | Note |", len(in.Overrides), func(i int) string {
		o := in.Overrides[i]
		return row(anilistLink(o.AnilistID), r.subject(o.BgmID), r.joinSays(o), cell(o.Note))
	})
	return capReport(r.b.String())
}

type reportWriter struct {
	b        strings.Builder
	subjects map[int]Subject
}

func (r *reportWriter) intro() {
	r.b.WriteString("Automated weekly regeneration of the vendored AniList→Bangumi id map " +
		"(Fribb/anime-lists × Rhilip/BangumiExtLinker, joined on MAL and AniDB ids) " +
		"and of the AniList→AniDB map.\n\n" +
		"Every row below changes which Bangumi subject the site trusts for a show — its Chinese title, " +
		"synopsis and episode names are copied from that subject. Check the Changed and Removed rows " +
		"against the shows themselves. Pin anything the join gets wrong in " +
		"`go-api/cmd/bgmmap/overrides.json` (with a note) and re-run the workflow. " +
		"Then merge and redeploy go-api: both maps are embedded via go:embed and seeded at boot.\n\n")
}

func (r *reportWriter) summary(in ReportInput, d MapDiff) {
	byReason := map[SkipReason]int{}
	for _, s := range in.Skips {
		byReason[s.Reason]++
	}
	reasons := []string{}
	for _, reason := range reportReasonOrder {
		if n := byReason[reason]; n > 0 {
			reasons = append(reasons, fmt.Sprintf("%s %d", reason, n))
		}
	}
	fmt.Fprintf(&r.b, "| | |\n|---|---|\n")
	fmt.Fprintf(&r.b, "| Entries | %d (was %d) |\n", len(in.Next), len(in.Prev))
	fmt.Fprintf(&r.b, "| Added / removed / changed | %d / %d / %d |\n", len(d.Added), len(d.Removed), len(d.Changed))
	fmt.Fprintf(&r.b, "| Refused by the join | %d — %s |\n", len(in.Skips), strings.Join(reasons, ", "))
	fmt.Fprintf(&r.b, "| Overrides | %d |\n", len(in.Overrides))
	fmt.Fprintf(&r.b, "| AniList → AniDB pairs | %d → %d |\n", in.AnidbBefore, in.AnidbAfter)
	fmt.Fprintf(&r.b, "| Upstream rows | Fribb %d, BangumiExtLinker %d |\n\n", in.Stats.FribbCount, in.Stats.BelCount)
}

// table writes a heading and up to reportRowCap rows of a markdown table.
func (r *reportWriter) table(heading, header string, n int, rowAt func(int) string) {
	fmt.Fprintf(&r.b, "%s\n\n", heading)
	if n == 0 {
		r.b.WriteString("None.\n\n")
		return
	}
	r.rows(header, n, rowAt)
}

// details is table inside a collapsed <details> block.
func (r *reportWriter) details(summary, header string, n int, rowAt func(int) string) {
	fmt.Fprintf(&r.b, "<details><summary>%s</summary>\n\n", summary)
	if n == 0 {
		r.b.WriteString("None.\n\n")
	} else {
		r.rows(header, n, rowAt)
	}
	r.b.WriteString("</details>\n\n")
}

func (r *reportWriter) rows(header string, n int, rowAt func(int) string) {
	r.b.WriteString(header + "\n")
	r.b.WriteString(strings.Repeat("|---", strings.Count(header, "|")-1) + "|\n")
	shown := min(n, reportRowCap)
	for i := 0; i < shown; i++ {
		r.b.WriteString(rowAt(i) + "\n")
	}
	if n > shown {
		fmt.Fprintf(&r.b, "\n_…and %d more not shown._\n", n-shown)
	}
	r.b.WriteString("\n")
}

func (r *reportWriter) subject(bgm int) string {
	s := r.subjects[bgm]
	name := s.Name
	if s.NameCN != "" && s.NameCN != s.Name {
		name = strings.TrimSpace(name + " / " + s.NameCN)
	}
	out := fmt.Sprintf("[%d](https://bgm.tv/subject/%d)", bgm, bgm)
	if name != "" {
		out += " " + cell(name)
	}
	if s.Date != "" {
		out += " (" + cell(s.Date) + ")"
	}
	return out
}

func (r *reportWriter) subjectList(ids []int) string {
	if len(ids) == 0 {
		return "—"
	}
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = r.subject(id)
	}
	return strings.Join(parts, "<br>")
}

// removalWhy names the refusal and the subjects competing with the one the
// map used to hold, once each: the MAL and AniDB sets usually coincide, and
// listing both doubled the report past the PR body limit.
func (r *reportWriter) removalWhy(skips map[int]Skip, e MapEntry) string {
	s, ok := skips[e.AnilistID]
	if !ok {
		return "no longer linked upstream"
	}
	others := idSet{}
	for _, ids := range [][]int{s.ViaMal, s.ViaAnidb} {
		for _, id := range ids {
			if id != e.BgmID {
				others[id] = struct{}{}
			}
		}
	}
	if len(others) == 0 {
		return reasonText(s.Reason)
	}
	return reasonText(s.Reason) + "; also: " + r.subjectList(others.sorted())
}

// otherRefusals is the refused ids the Removed table does not already show:
// ids that were not in the previous map, or that an override now holds.
func otherRefusals(skips []Skip, removed []MapEntry) []Skip {
	shown := make(map[int]bool, len(removed))
	for _, e := range removed {
		shown[e.AnilistID] = true
	}
	out := []Skip{}
	for _, s := range skips {
		if !shown[s.AnilistID] {
			out = append(out, s)
		}
	}
	return out
}

func (r *reportWriter) joinSays(o OverrideOutcome) string {
	switch {
	case o.JoinSkip != "":
		return "refused: " + reasonText(o.JoinSkip)
	case o.JoinBgmID == 0:
		return "no answer"
	case o.JoinBgmID == o.BgmID:
		return "agrees — the override can go"
	default:
		return r.subject(o.JoinBgmID)
	}
}

func reasonText(reason SkipReason) string {
	switch reason {
	case SkipMalAnidbDisagree:
		return "MAL and AniDB name different subjects"
	case SkipAmbiguousMal:
		return "several Bangumi subjects share the MAL id"
	case SkipAmbiguousAnidb:
		return "several Bangumi subjects share the AniDB id"
	case SkipFribbRowsDisagree:
		return "Fribb lists the id more than once and the rows disagree"
	}
	return string(reason)
}

func anilistLink(id int) string {
	return fmt.Sprintf("[%d](https://anilist.co/anime/%d)", id, id)
}

func row(cells ...string) string {
	return "| " + strings.Join(cells, " | ") + " |"
}

// cell makes upstream text safe inside a markdown table cell.
func cell(s string) string {
	s = strings.ReplaceAll(s, "|", `\|`)
	return strings.Join(strings.Fields(s), " ")
}

// capReport cuts at the last line break under the limit, so a cut never
// splits a multi-byte character, and says that it did.
func capReport(s string) string {
	const note = "\n\n_Report cut here: it would exceed the PR body limit._\n"
	if len(s) <= maxReportBytes {
		return s
	}
	cut := strings.LastIndexByte(s[:maxReportBytes-len(note)], '\n')
	if cut < 0 {
		cut = 0
	}
	return s[:cut] + note
}
