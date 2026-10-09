package bgmnames

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// InputReader is the statement set LoadInput runs.  *dbgen.Queries
// satisfies it.
type InputReader interface {
	ListBgmBoundTitles(ctx context.Context) ([]dbgen.ListBgmBoundTitlesRow, error)
	ListBgmCastVoices(ctx context.Context) ([]dbgen.ListBgmCastVoicesRow, error)
	ListBgmCreditedStaff(ctx context.Context) ([]dbgen.ListBgmCreditedStaffRow, error)
}

// LoadInput reads our side of the match: the bound titles, every voice
// and every staff credit on them.
func LoadInput(ctx context.Context, r InputReader) (Input, error) {
	var in Input
	titles, err := r.ListBgmBoundTitles(ctx)
	if err != nil {
		return in, fmt.Errorf("list bound titles: %w", err)
	}
	for _, t := range titles {
		in.Titles = append(in.Titles, Title{AnilistID: t.AnilistID, BgmSubject: t.BgmID})
	}
	voices, err := r.ListBgmCastVoices(ctx)
	if err != nil {
		return in, fmt.Errorf("list voices: %w", err)
	}
	for _, v := range voices {
		in.Voices = append(in.Voices, Voice{AnimeID: v.AnimeID, CharacterID: v.CharacterID,
			CharacterNative: deref(v.CharacterNative), StaffID: v.StaffID, StaffNative: deref(v.StaffNative)})
	}
	staff, err := r.ListBgmCreditedStaff(ctx)
	if err != nil {
		return in, fmt.Errorf("list staff: %w", err)
	}
	for _, s := range staff {
		in.Staff = append(in.Staff, Credit{AnimeID: s.AnimeID, StaffID: s.StaffID, StaffNative: deref(s.StaffNative)})
	}
	return in, nil
}

// Options is one run's settings.
type Options struct {
	// DumpDir is an extracted Bangumi Archive dump: a directory holding
	// DumpFiles.
	DumpDir string
	// Source is stored with every row the run writes.  Empty means the
	// name of DumpDir, so name the directory after the zip
	// (dump-2026-10-06.210359Z).
	Source string
	// Apply writes the matches; without it the run reads and reports.
	Apply bool
	// Now stamps written rows; nil means time.Now.
	Now func() time.Time
}

// Report is what a run found and what it changed (or would change).
type Report struct {
	Result
	Source  string
	Applied bool
	Changes Changes
}

// Run is one import: read our bound titles' credits, read the dump for
// their subjects, match, and either report what a write would change or
// write it.
func Run(ctx context.Context, pool *pgxpool.Pool, opts Options) (*Report, error) {
	source := opts.Source
	if source == "" {
		source = filepath.Base(filepath.Clean(opts.DumpDir))
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}

	q := dbgen.New(pool)
	in, err := LoadInput(ctx, q)
	if err != nil {
		return nil, err
	}
	subjects := make(map[int32]bool, len(in.Titles))
	for _, t := range in.Titles {
		subjects[t.BgmSubject] = true
	}
	archive, err := LoadArchive(opts.DumpDir, subjects)
	if err != nil {
		return nil, fmt.Errorf("read dump: %w", err)
	}

	rep := &Report{Result: Match(in, archive), Source: source}
	if !opts.Apply {
		rep.Changes, err = Preview(ctx, q, rep.Result)
		return rep, err
	}
	rep.Changes, err = Apply(ctx, pool, rep.Result, source, now())
	if err != nil {
		return nil, fmt.Errorf("write: %w", err)
	}
	rep.Applied = true
	return rep, nil
}

// maxConflictLines bounds the conflicts Write lists.
const maxConflictLines = 20

// Write prints the report: the counts, the conflicts, up to samples pairs
// of each kind, and the change to each table.
func (r *Report) Write(w io.Writer, samples int) {
	mode := "dry run: nothing written"
	if r.Applied {
		mode = "written"
	}
	s := r.Stats
	fmt.Fprintf(w, "Bangumi Archive import from %s (%s)\n\n", r.Source, mode)
	fmt.Fprintf(w, "titles bound to a Bangumi subject: %d  (subject not in the dump: %d, with at least one match: %d)\n",
		s.Titles, s.TitlesNotInDump, s.TitlesMatched)
	fmt.Fprintf(w, "people:     %d considered, %d matched (%s), %d with a Chinese name; by voice %d, by staff %d; %d in conflicts, %d unmatched\n",
		s.PeopleConsidered, s.PeopleMatched, percent(s.PeopleMatched, s.PeopleConsidered), s.PeopleNamed,
		s.ByVoice, s.ByStaff, s.PeopleConflicted, s.PeopleConsidered-s.PeopleMatched-s.PeopleConflicted)
	fmt.Fprintf(w, "characters: %d considered, %d matched (%s), %d with a Chinese name, %d with a summary; %d in conflicts, %d unmatched\n",
		s.CharactersConsidered, s.CharactersMatched, percent(s.CharactersMatched, s.CharactersConsidered), s.CharactersNamed,
		withSummary(r.Characters), s.CharactersConflicted, s.CharactersConsidered-s.CharactersMatched-s.CharactersConflicted)

	fmt.Fprintf(w, "\nconflicts: %d (written neither way)\n", len(r.Conflicts))
	for i, c := range r.Conflicts {
		if i == maxConflictLines {
			fmt.Fprintf(w, "  ... %d more\n", len(r.Conflicts)-i)
			break
		}
		fmt.Fprintf(w, "  %-10s AniList %v  Bangumi %v  titles %v\n", c.Kind, c.AnilistIDs, c.BgmIDs, c.Titles)
	}
	writeSamples(w, "people", r.People, samples)
	writeSamples(w, "characters", r.Characters, samples)

	verb := "would"
	if r.Applied {
		verb = "did"
	}
	fmt.Fprintln(w)
	for _, t := range []struct {
		table string
		c     Change
	}{{"bgm_person_map", r.Changes.People}, {"bgm_character_map", r.Changes.Characters}} {
		fmt.Fprintf(w, "%-18s %s insert %d, update %d, delete %d; %d unchanged\n",
			t.table+":", verb, t.c.Inserted, t.c.Updated, t.c.Deleted, t.c.Unchanged)
	}
}

// withSummary counts the pairs that carry a summary.
func withSummary(pairs []Pair) int {
	n := 0
	for _, p := range pairs {
		if p.Summary != "" {
			n++
		}
	}
	return n
}

// writeSamples lists the first n pairs of a kind.
func writeSamples(w io.Writer, kind string, pairs []Pair, n int) {
	if n <= 0 || len(pairs) == 0 {
		return
	}
	fmt.Fprintf(w, "\n%s (first %d of %d):\n", kind, min(n, len(pairs)), len(pairs))
	for _, p := range pairs[:min(n, len(pairs))] {
		cn := p.NameCn
		if cn == "" {
			cn = "(no Chinese name)"
		}
		fmt.Fprintf(w, "  AniList %-7d %s  ->  Bangumi %-7d %s  ->  %s   titles %v\n",
			p.AnilistID, p.AniListName, p.BgmID, p.BgmName, cn, p.Titles)
	}
}

// percent formats part/whole, or "-" for an empty whole.
func percent(part, whole int) string {
	if whole == 0 {
		return "-"
	}
	return fmt.Sprintf("%.1f%%", 100*float64(part)/float64(whole))
}
