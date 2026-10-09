package people

import (
	"context"
	"log/slog"
	"strings"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/overlay"
)

// OverlayDB reads the accepted reader edits (entity_overlays, 0047) and the
// people an edit names that a page's own credits do not carry.
type OverlayDB interface {
	ListEntityOverlays(ctx context.Context, personIds []int32, characterIds []int32) ([]dbgen.ListEntityOverlaysRow, error)
	ListPersonRefs(ctx context.Context, ids []int32) ([]dbgen.ListPersonRefsRow, error)
}

// pageOverlays is every accepted edit one page reads: its own, and those of
// the people or characters it lists.  The zero value applies nothing.
type pageOverlays struct {
	self       overlay.Doc
	people     map[int32]overlay.Doc
	characters map[int32]overlay.Doc
	// refs are the people a voice edit names, for rows the credits do not
	// carry them on.
	refs map[int32]PersonRef
}

// decodeOverlays reads the rows of ListEntityOverlays into one map per
// kind.  A document that does not decode is logged and left out: the page
// then shows what AniList and Bangumi say, which is what it showed before
// the edit, rather than an error.
func decodeOverlays(rows []dbgen.ListEntityOverlaysRow) (people, characters map[int32]overlay.Doc) {
	people, characters = map[int32]overlay.Doc{}, map[int32]overlay.Doc{}
	for _, r := range rows {
		doc, err := overlay.Decode(r.Data)
		if err != nil {
			slog.Warn("people: unreadable overlay ignored", "kind", r.Kind, "id", r.EntityID, "err", err)
			continue
		}
		switch overlay.Kind(r.Kind) {
		case overlay.Person:
			people[r.EntityID] = doc
		case overlay.Character:
			characters[r.EntityID] = doc
		}
	}
	return people, characters
}

// personRefFromRow is a ListPersonRefs row as a credit line shows it: the
// person page's ladder (profile, then credit; Bangumi alone for the Chinese
// name; the large portrait).
func personRefFromRow(r dbgen.ListPersonRefsRow) PersonRef {
	return PersonRef{
		AnilistID: r.AnilistID,
		Name: Name{
			Full:   firstText(r.NameFull, r.CreditFull),
			Native: firstText(r.NameNative, r.CreditNative),
			Cn:     text(r.NameCn),
		},
		Image: firstText(r.ImageLarge, largeImage(r.CreditImage)),
	}
}

// nameWith is a name with an overlay's names in front of it.
func nameWith(n Name, o overlay.Doc) Name {
	out := n
	if v := text(o.NameFull.Value); v != nil {
		out.Full = v
	}
	if v := text(o.NameNative.Value); v != nil {
		out.Native = v
	}
	if v := text(o.NameCn.Value); v != nil {
		out.Cn = v
	}
	return out
}

// imageWith is the overlay's image when it has one, else img.
func imageWith(img *string, o overlay.Doc) *string {
	if v := text(o.Image.Value); v != nil {
		return v
	}
	return img
}

// roleWith is the character's role on a title: the accepted one, else the
// credit's.
func roleWith(role *string, o overlay.Doc, animeID int32) *string {
	if r, ok := o.Role(animeID); ok {
		return &r
	}
	return role
}

func characterRefWith(ref CharacterRef, o overlay.Doc) CharacterRef {
	return CharacterRef{AnilistID: ref.AnilistID, Name: nameWith(ref.Name, o), Image: imageWith(ref.Image, o)}
}

func personRefWith(ref PersonRef, o overlay.Doc) PersonRef {
	return PersonRef{AnilistID: ref.AnilistID, Name: nameWith(ref.Name, o), Image: imageWith(ref.Image, o)}
}

// dateWith is an overlay's birthday as the pages carry one; nil when it
// clears the date or knows no part of it.
func dateWith(d *overlay.Date) *FuzzyDate {
	if d == nil {
		return nil
	}
	return fuzzyDate(d.Year, d.Month, d.Day)
}

// cleanList is a list without blanks and repeats, never nil.
func cleanList(list *[]string) []string {
	out := []string{}
	if list == nil {
		return out
	}
	seen := map[string]bool{}
	for _, s := range *list {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// characterProfileWith is a character's profile with an overlay's facts
// applied.  An edit can give a profile to a character the sweep has not
// reached: the facts it sets are the profile then.
func characterProfileWith(p *CharacterProfile, o overlay.Doc) *CharacterProfile {
	if !o.Description.Set && !o.Gender.Set && !o.Age.Set && !o.Birth.Set && !o.BloodType.Set {
		return p
	}
	next := CharacterProfile{}
	if p != nil {
		next = *p
	}
	if o.Description.Set {
		next.Description = text(o.Description.Value)
	}
	if o.Gender.Set {
		next.Gender = text(o.Gender.Value)
	}
	if o.Age.Set {
		next.Age = text(o.Age.Value)
	}
	if o.Birth.Set {
		next.Birth = dateWith(o.Birth.Value)
	}
	if o.BloodType.Set {
		next.BloodType = text(o.BloodType.Value)
	}
	return &next
}

// personProfileWith is characterProfileWith for a person.
func personProfileWith(p *PersonProfile, o overlay.Doc) *PersonProfile {
	if !o.Occupations.Set && !o.Gender.Set && !o.Birth.Set && !o.HomeTown.Set && !o.BloodType.Set {
		return p
	}
	next := PersonProfile{Occupations: []string{}, YearsActive: []int32{}}
	if p != nil {
		next = *p
	}
	if o.Occupations.Set {
		next.Occupations = cleanList(o.Occupations.Value)
	}
	if o.Gender.Set {
		next.Gender = text(o.Gender.Value)
	}
	if o.Birth.Set {
		next.Birth = dateWith(o.Birth.Value)
	}
	if o.HomeTown.Set {
		next.HomeTown = text(o.HomeTown.Value)
	}
	if o.BloodType.Set {
		next.BloodType = text(o.BloodType.Value)
	}
	return &next
}

// voicesWith applies a character's accepted voice edits to the voices its
// credits list, in the credits' order, and appends the voices edits added,
// in the order they were accepted.  A row given to someone the database no
// longer credits anywhere keeps its credited person -- the page cannot link
// to the one the edit named -- and an added voice for such a person is
// left out.  The people's own edits (names, portraits) are applied after,
// by the caller, to every row alike.
func voicesWith(base []CharacterVoice, self overlay.Doc, refs map[int32]PersonRef) []CharacterVoice {
	out := make([]CharacterVoice, 0, len(base)+len(self.Voices))
	for _, v := range base {
		op, ok := self.VoiceOp(v.Key)
		if !ok {
			out = append(out, v)
			continue
		}
		if op.Remove {
			continue
		}
		next := v
		if op.PersonID != 0 && op.PersonID != v.Person.AnilistID {
			if ref, found := refs[op.PersonID]; found {
				next.Person = ref
			}
		}
		if line := text(op.Line); line != nil {
			next.Line = line
		}
		out = append(out, next)
	}
	for _, op := range self.Voices {
		personID, added := overlay.AddedVoicePerson(op.Key)
		if !added || op.Remove {
			continue
		}
		if op.PersonID != 0 {
			personID = op.PersonID
		}
		ref, found := refs[personID]
		if !found {
			continue
		}
		out = append(out, CharacterVoice{Key: op.Key, Person: ref, Line: text(op.Line)})
	}
	return out
}

// voicePeople is every person a character's voices could show after its
// edits: the credited ones and the ones its voice edits name.
func voicePeople(rows []dbgen.ListCharacterVoicesRow, self overlay.Doc) (all []int32, uncredited []int32) {
	credited := map[int32]bool{}
	for _, r := range rows {
		if !credited[r.StaffID] {
			credited[r.StaffID] = true
			all = append(all, r.StaffID)
		}
	}
	named := map[int32]bool{}
	for _, op := range self.Voices {
		id := op.PersonID
		if id == 0 {
			id, _ = overlay.AddedVoicePerson(op.Key)
		}
		if id <= 0 || op.Remove || credited[id] || named[id] {
			continue
		}
		named[id] = true
		all = append(all, id)
		uncredited = append(uncredited, id)
	}
	return all, uncredited
}
