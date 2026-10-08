package credits

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// Mode says what a write's rows are, and therefore what it may remove.
type Mode uint8

const (
	// FirstPage: the rows are AniList's first page and nothing else -- the
	// detail refresh, when AniList says there is a second page.  The rows
	// beyond the first page belong to the credits sweep and are kept;
	// they are renumbered to follow the first page, so the first page is
	// always display_order 0..n-1 and is what a 25-row read returns.
	FirstPage Mode = iota

	// WholeList: the rows are everything the title should hold -- the
	// sweep's full fetch, or a first page AniList says is the last.  Every
	// other row of the title is deleted.
	WholeList
)

// CastWriter is the statement set WriteCast runs.  *dbgen.Queries
// satisfies it, bound to a transaction (the sweep) or not (the detail
// refresh, whose writes have always been statement-at-a-time).
type CastWriter interface {
	UpsertAnimeCharacter(ctx context.Context, arg dbgen.UpsertAnimeCharacterParams) (uuid.UUID, error)
	PruneAnimeCharacters(ctx context.Context, animeID int32, keep []uuid.UUID, wholeList bool) error
	RenumberAnimeCharacters(ctx context.Context, firstOrder int32, animeID int32, keep []uuid.UUID) error
	PruneAnimeCharacterVoices(ctx context.Context, animeID int32, characterIds []int32) error
	UpsertAnimeCharacterVoice(ctx context.Context, arg dbgen.UpsertAnimeCharacterVoiceParams) error
}

// StaffWriter is the statement set WriteStaff runs.
type StaffWriter interface {
	UpsertAnimeStaff(ctx context.Context, arg dbgen.UpsertAnimeStaffParams) (uuid.UUID, error)
	PruneAnimeStaff(ctx context.Context, animeID int32, keep []uuid.UUID, wholeList bool) error
	RenumberAnimeStaff(ctx context.Context, firstOrder int32, animeID int32, keep []uuid.UUID) error
}

// WriteCast stores a title's characters and their voices.
//
// The statement order is the design:
//
//  1. Upsert every row, keyed (anime_id, character_id), collecting the
//     row ids.  First, so a reader of a title being rewritten sees the old
//     list or the new one, never an empty one -- which is what the old
//     delete-then-insert showed for the length of the write.
//  2. Prune what the mode says may go: in WholeList every row not written,
//     in FirstPage only rows that have no character id (rows from before
//     0037, or an earlier copy of an id-less node; nothing can address
//     them, so nothing else will ever clean them up).
//  3. FirstPage only: renumber the rows not written to follow the first
//     page.  Without this a character that slipped off page 1 keeps its
//     old position and sorts among the new page, and the 25-row read
//     returns it in place of one AniList lists.
//  4. Replace the voices of the characters written, and drop voices whose
//     character row is gone (pruned in step 2, or deleted by an admin
//     reset).  The voices of rows the write did not touch stay with them.
//
// Not transactional by itself: the caller decides.  The sweep wraps it in
// one transaction; the detail refresh does not, as before, and a refresh
// that fails half-way leaves a mix of old and new rows that the next
// refresh replaces.  Every insert is an upsert because the two can run at
// once on one title -- whichever lands second updates what the first
// wrote instead of failing on the key.
func WriteCast(ctx context.Context, w CastWriter, animeID int32, cast Cast, mode Mode) error {
	keep := make([]uuid.UUID, 0, len(cast.Characters))
	written := make([]int32, 0, len(cast.Characters))
	for _, c := range cast.Characters {
		id, err := w.UpsertAnimeCharacter(ctx, dbgen.UpsertAnimeCharacterParams{
			AnimeID:            animeID,
			DisplayOrder:       c.DisplayOrder,
			NameEn:             c.NameEn,
			NameJa:             c.NameJa,
			ImageUrl:           c.ImageUrl,
			Role:               c.Role,
			VoiceActorEn:       c.VoiceActorEn,
			VoiceActorJa:       c.VoiceActorJa,
			VoiceActorImageUrl: c.VoiceActorImageUrl,
			CharacterID:        c.CharacterID,
			VoiceActorID:       c.VoiceActorID,
		})
		if err != nil {
			return fmt.Errorf("upsert character %d: %w", c.DisplayOrder, err)
		}
		keep = append(keep, id)
		if c.CharacterID != nil {
			written = append(written, *c.CharacterID)
		}
	}

	if err := w.PruneAnimeCharacters(ctx, animeID, keep, mode == WholeList); err != nil {
		return fmt.Errorf("prune characters: %w", err)
	}
	if mode == FirstPage {
		if err := w.RenumberAnimeCharacters(ctx, int32(len(keep)), animeID, keep); err != nil {
			return fmt.Errorf("renumber characters: %w", err)
		}
	}

	if err := w.PruneAnimeCharacterVoices(ctx, animeID, written); err != nil {
		return fmt.Errorf("prune voices: %w", err)
	}
	for _, v := range cast.Voices {
		if err := w.UpsertAnimeCharacterVoice(ctx, dbgen.UpsertAnimeCharacterVoiceParams{
			AnimeID:      animeID,
			CharacterID:  v.CharacterID,
			StaffID:      v.StaffID,
			DisplayOrder: v.DisplayOrder,
			Language:     v.Language,
			RoleNotes:    v.RoleNotes,
			DubGroup:     v.DubGroup,
			NameFull:     v.NameFull,
			NameNative:   v.NameNative,
			ImageUrl:     v.ImageUrl,
		}); err != nil {
			return fmt.Errorf("upsert voice %d/%d: %w", v.CharacterID, v.StaffID, err)
		}
	}
	return nil
}

// WriteStaff stores a title's staff: WriteCast's steps 1-3, keyed
// (anime_id, staff_id, role).
func WriteStaff(ctx context.Context, w StaffWriter, animeID int32, staff []Staff, mode Mode) error {
	keep := make([]uuid.UUID, 0, len(staff))
	for _, s := range staff {
		id, err := w.UpsertAnimeStaff(ctx, dbgen.UpsertAnimeStaffParams{
			AnimeID:      animeID,
			DisplayOrder: s.DisplayOrder,
			NameEn:       s.NameEn,
			NameJa:       s.NameJa,
			ImageUrl:     s.ImageUrl,
			Role:         s.Role,
			StaffID:      s.StaffID,
		})
		if err != nil {
			return fmt.Errorf("upsert staff %d: %w", s.DisplayOrder, err)
		}
		keep = append(keep, id)
	}

	if err := w.PruneAnimeStaff(ctx, animeID, keep, mode == WholeList); err != nil {
		return fmt.Errorf("prune staff: %w", err)
	}
	if mode == FirstPage {
		if err := w.RenumberAnimeStaff(ctx, int32(len(keep)), animeID, keep); err != nil {
			return fmt.Errorf("renumber staff: %w", err)
		}
	}
	return nil
}

// ModeFor is the mode a first page should be written in: WholeList when
// AniList says it is also the last page, FirstPage when there is more or
// when the document did not say.  Not knowing is treated as "more" -- the
// cautious reading, since FirstPage only ever keeps rows and WholeList
// deletes them.
func ModeFor(hasNext, known bool) Mode {
	if known && !hasNext {
		return WholeList
	}
	return FirstPage
}
