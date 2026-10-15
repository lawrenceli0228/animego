package main

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

// maxReportBytes keeps the report under GitHub's 65,536-character PR body
// limit with room to spare; past it the create-pull-request step fails and
// the refresh opens no PR at all.
const maxReportBytes = 60000

// reportRowCap bounds each table.  A normal week changes a handful of rows;
// thousands means an upstream outage, and the counts say that on their own.
const reportRowCap = 150

// Change is one id whose Mikan page changed between two maps.  From is 0
// for an added id, To is 0 for a removed one.
type Change struct {
	Key      Key
	ID       int
	From, To int
}

// Diff is what a refresh does to one of the two lookups.
type Diff struct {
	Added, Removed, Changed []Change
}

// DiffIDs compares two lookups keyed by key, each list sorted by id.
func DiffIDs(key Key, prev, next map[int]int) Diff {
	var d Diff
	for _, id := range slices.Sorted(maps.Keys(next)) {
		old, ok := prev[id]
		switch {
		case !ok:
			d.Added = append(d.Added, Change{Key: key, ID: id, To: next[id]})
		case old != next[id]:
			d.Changed = append(d.Changed, Change{Key: key, ID: id, From: old, To: next[id]})
		}
	}
	for _, id := range slices.Sorted(maps.Keys(prev)) {
		if _, ok := next[id]; !ok {
			d.Removed = append(d.Removed, Change{Key: key, ID: id, From: prev[id]})
		}
	}
	return d
}

// ReportInput is everything the weekly PR body is built from.
type ReportInput struct {
	Prev      Map // the vendored map before this run; the zero Map on a first run
	Next      Map
	Conflicts []Conflict
	Pages     map[int]Page
	Stats     Stats
}

// RenderReport writes the refresh PR's body: the summary, every conflict
// with the pages it names, and what changed against the vendored map.
func RenderReport(in ReportInput) string {
	anilist := DiffIDs(KeyAnilist, in.Prev.Anilist, in.Next.Anilist)
	bgm := DiffIDs(KeyBgm, in.Prev.Bgm, in.Next.Bgm)
	r := reportWriter{pages: in.Pages}

	r.b.WriteString("Automated weekly regeneration of the vendored AniList / Bangumi → Mikan Project bangumi id map " +
		"(`go-api/internal/mikanidmap/mikan_map.json`), built from " +
		"[bangumi-data](https://github.com/bangumi-data/bangumi-data) (CC BY 4.0).\n\n" +
		"An anime whose id is in this map gets Mikan's per-bangumi RSS feed in its magnet list instead of " +
		"Mikan's keyword search, so a wrong page puts another show's releases in that list. Check the " +
		"Changed and Removed rows against the pages they name; corrections belong upstream in bangumi-data. " +
		"Merge and redeploy go-api to ship it: the map is embedded via go:embed.\n\n")
	r.summary(in, anilist, bgm)

	r.table(fmt.Sprintf("### Conflicts, left out of the map (%d)", len(in.Conflicts)), "| Key | Id | Mikan pages |", len(in.Conflicts), func(i int) string {
		c := in.Conflicts[i]
		return row(keyName(c.Key), idLink(c.Key, c.ID), r.pageList(c.Mikan))
	})
	changed := append(append([]Change{}, anilist.Changed...), bgm.Changed...)
	r.table(fmt.Sprintf("### Changed (%d)", len(changed)), "| Key | Id | Before | After |", len(changed), func(i int) string {
		c := changed[i]
		return row(keyName(c.Key), idLink(c.Key, c.ID), r.page(c.From), r.page(c.To))
	})
	removed := append(append([]Change{}, anilist.Removed...), bgm.Removed...)
	r.table(fmt.Sprintf("### Removed (%d)", len(removed)), "| Key | Id | Was |", len(removed), func(i int) string {
		c := removed[i]
		return row(keyName(c.Key), idLink(c.Key, c.ID), r.page(c.From))
	})
	added := append(append([]Change{}, anilist.Added...), bgm.Added...)
	r.details(fmt.Sprintf("Added (%d)", len(added)), "| Key | Id | Mikan page |", len(added), func(i int) string {
		c := added[i]
		return row(keyName(c.Key), idLink(c.Key, c.ID), r.page(c.To))
	})
	return capReport(r.b.String())
}

type reportWriter struct {
	b     strings.Builder
	pages map[int]Page
}

func (r *reportWriter) summary(in ReportInput, anilist, bgm Diff) {
	version := in.Next.Version
	if in.Prev.Version != "" && in.Prev.Version != in.Next.Version {
		version += fmt.Sprintf(" (was %s)", in.Prev.Version)
	}
	conflicts := map[Key]int{}
	for _, c := range in.Conflicts {
		conflicts[c.Key]++
	}
	r.b.WriteString("| | |\n|---|---|\n")
	fmt.Fprintf(&r.b, "| bangumi-data release | %s |\n", cell(version))
	fmt.Fprintf(&r.b, "| Items linking a Mikan page | %d of %d |\n", in.Stats.WithMikan, in.Stats.Items)
	fmt.Fprintf(&r.b, "| AniList keys | %d (was %d): +%d / −%d / changed %d |\n",
		len(in.Next.Anilist), len(in.Prev.Anilist), len(anilist.Added), len(anilist.Removed), len(anilist.Changed))
	fmt.Fprintf(&r.b, "| Bangumi keys | %d (was %d): +%d / −%d / changed %d |\n",
		len(in.Next.Bgm), len(in.Prev.Bgm), len(bgm.Added), len(bgm.Removed), len(bgm.Changed))
	fmt.Fprintf(&r.b, "| Conflicts, left out | AniList %d, Bangumi %d |\n", conflicts[KeyAnilist], conflicts[KeyBgm])
	fmt.Fprintf(&r.b, "| Items with no AniList link | %d (reachable by Bangumi id only) |\n", in.Stats.NoAnilist)
	fmt.Fprintf(&r.b, "| Ids skipped as not numeric | %d |\n\n", in.Stats.BadIDs)
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

// page names one Mikan page: its link, the bangumi-data titles and the
// date it began.
func (r *reportWriter) page(id int) string {
	out := fmt.Sprintf("[%d](https://mikanani.me/Home/Bangumi/%d)", id, id)
	p := r.pages[id]
	name := p.Title
	if p.TitleCN != "" && p.TitleCN != p.Title {
		name = strings.TrimSpace(name + " / " + p.TitleCN)
	}
	if name != "" {
		out += " " + cell(name)
	}
	if p.Begin != "" {
		out += " (" + cell(p.Begin) + ")"
	}
	return out
}

func (r *reportWriter) pageList(ids []int) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = r.page(id)
	}
	return strings.Join(parts, "<br>")
}

func keyName(k Key) string {
	if k == KeyAnilist {
		return "AniList"
	}
	return "Bangumi"
}

func idLink(k Key, id int) string {
	if k == KeyAnilist {
		return fmt.Sprintf("[%d](https://anilist.co/anime/%d)", id, id)
	}
	return fmt.Sprintf("[%d](https://bgm.tv/subject/%d)", id, id)
}

func row(cells ...string) string {
	return "| " + strings.Join(cells, " | ") + " |"
}

// wordJoiner is U+2060: invisible, but it breaks "#12" and "@name" apart so
// GitHub neither links an unrelated issue nor pings a user.  Titles carry
// both ("THE IDOLM@STER").  Same rule as cmd/bgmmap's report.
const wordJoiner = "⁠"

// cell makes upstream text safe inside a markdown table cell.
func cell(s string) string {
	s = strings.ReplaceAll(s, "|", `\|`)
	s = strings.ReplaceAll(s, "#", "#"+wordJoiner)
	s = strings.ReplaceAll(s, "@", "@"+wordJoiner)
	return strings.Join(strings.Fields(s), " ")
}

// capReport cuts at the last line break under the limit, so a cut never
// splits a multi-byte character, closes a <details> the cut left open, and
// says that it cut.
func capReport(s string) string {
	const closeDetails = "\n\n</details>"
	const note = "\n\n_Report cut here: it would exceed the PR body limit._\n"
	if len(s) <= maxReportBytes {
		return s
	}
	cut := strings.LastIndexByte(s[:maxReportBytes-len(closeDetails)-len(note)], '\n')
	if cut < 0 {
		cut = 0
	}
	out := s[:cut]
	if strings.Count(out, "<details>") > strings.Count(out, "</details>") {
		out += closeDetails
	}
	return out + note
}
