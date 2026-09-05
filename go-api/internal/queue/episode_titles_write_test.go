package queue

import (
	"context"
	"testing"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// A row carrying no name in either language is two NULLs. It renders exactly
// like no row at all, and it makes "how many titles do we hold for this
// anime" unanswerable by counting rows. internal/episodetitles.Usable has
// dropped these on the dandanplay side since it was written; this side had
// not, and the gap stayed invisible until the RELEASING sweep began routing
// rows here -- 21,370 such rows across 1,329 anime had accumulated, one
// airing ONA contributing 228 by itself.
//
// The filter belongs here and not in normalizeEpisodeTitles: that function
// also feeds episodes_bgm, which derives a COUNT from the list, and an
// episode Bangumi has not named is still an episode.

type recordingUpserter struct {
	got []dbgen.UpsertEpisodeTitleSourcedParams
}

func (r *recordingUpserter) UpsertEpisodeTitleSourced(_ context.Context, arg dbgen.UpsertEpisodeTitleSourcedParams) (int64, error) {
	r.got = append(r.got, arg)
	return 1, nil
}

func strp(s string) *string { return &s }

func TestWriteEpisodeTitles_SkipsEpisodesNamedInNeitherLanguage(t *testing.T) {
	t.Parallel()

	db := &recordingUpserter{}
	written, failures := writeEpisodeTitles(context.Background(), db, 1234, 9999, []epTitle{
		{episode: 1, name: strp("E1"), nameCN: strp("第一集")},
		{episode: 2},                      // named in neither language
		{episode: 3, nameCN: strp("第三集")}, // CN only still writes
		{episode: 4, name: strp("E4")},    // JA only still writes
	})

	if written != 3 || failures != 0 {
		t.Fatalf("want 3 written / 0 failures, got %d / %d", written, failures)
	}
	if len(db.got) != 3 {
		t.Fatalf("the nameless episode must never reach the upsert: %d calls", len(db.got))
	}
	for _, g := range db.got {
		if g.Episode == 2 {
			t.Fatalf("episode 2 has no name in either language and must not be written")
		}
	}
}

func TestWriteEpisodeTitles_ANamelessEpisodeIsNotCountedAsAFailure(t *testing.T) {
	t.Parallel()

	// Skipping is a decision, not a write that went wrong. Counting it as a
	// failure would put a WARN in the log for every airing show whose upstream
	// lists more episodes than it has named -- which is most of them.
	db := &recordingUpserter{}
	_, failures := writeEpisodeTitles(context.Background(), db, 1234, 9999, []epTitle{
		{episode: 1}, {episode: 2}, {episode: 3},
	})
	if failures != 0 {
		t.Fatalf("skipped rows must not be reported as failures, got %d", failures)
	}
}
