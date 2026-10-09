package edits

import (
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"strconv"

	"github.com/google/uuid"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/overlay"
	"github.com/lawrenceli0228/animego/go-api/internal/people"
)

// An item is a change from the value its submitter saw to a new one.  Another
// reader's submission on the same page may be accepted before it is
// reviewed: a name changed, an alias added, a voice row given to someone
// else.  Accepting the later item then would write back what its submitter
// saw along with what they changed -- a list without the alias the other
// reader added, the row's old voice with its new line -- undoing the first
// change without anyone choosing to.
//
// So an item applies only while the page still shows the value it was made
// against.  The review marks the others stale and will not accept them; the
// admin rejects them with a note, and the submitter can make the change
// again on the page as it is now.

// pageValue reads one field of the page as it is now, in the shape an item's
// old value has (diffCharacter, diffPerson, and the photo in Submit).  ok is
// false for a title the page no longer lists.
type pageValue func(field, key string) (value json.RawMessage, ok bool)

// characterValue is pageValue for a character page.
func characterValue(c *people.Character) pageValue {
	profile := c.Profile
	if profile == nil {
		profile = &people.CharacterProfile{}
	}
	return func(field, key string) (json.RawMessage, bool) {
		if v, ok := nameValue(c.Name, field); ok {
			return v, true
		}
		switch field {
		case overlay.FieldAliases:
			return mustJSON(c.AlternativeNames), true
		case overlay.FieldImage:
			return mustJSON(c.Image), true
		case overlay.FieldGender:
			return mustJSON(trimmed(profile.Gender)), true
		case overlay.FieldAge:
			return mustJSON(trimmed(profile.Age)), true
		case overlay.FieldBirth:
			return mustJSON(profile.Birth), true
		case overlay.FieldBloodType:
			return mustJSON(trimmed(profile.BloodType)), true
		case overlay.FieldDescription:
			return mustJSON(trimmed(profile.Description)), true
		case overlay.FieldVoice:
			// A row the page does not list reads as null: what an added
			// row was made against, and what a removed one now is.
			for _, v := range c.Voices {
				if v.Key == key {
					return mustJSON(voiceValueOf(v)), true
				}
			}
			return mustJSON(nil), true
		case overlay.FieldRole:
			for _, a := range c.Appearances {
				if strconv.FormatInt(int64(a.Anime.AnilistID), 10) == key {
					return mustJSON(a.Role), true
				}
			}
		}
		return nil, false
	}
}

// personValue is pageValue for a person page.
func personValue(p *people.Person) pageValue {
	profile := p.Profile
	if profile == nil {
		profile = &people.PersonProfile{Occupations: []string{}}
	}
	return func(field, _ string) (json.RawMessage, bool) {
		if v, ok := nameValue(p.Name, field); ok {
			return v, true
		}
		switch field {
		case overlay.FieldOccupations:
			return mustJSON(profile.Occupations), true
		case overlay.FieldImage:
			return mustJSON(p.Image), true
		case overlay.FieldGender:
			return mustJSON(trimmed(profile.Gender)), true
		case overlay.FieldBirth:
			return mustJSON(profile.Birth), true
		case overlay.FieldHomeTown:
			return mustJSON(trimmed(profile.HomeTown)), true
		case overlay.FieldBloodType:
			return mustJSON(trimmed(profile.BloodType)), true
		}
		return nil, false
	}
}

func nameValue(n people.Name, field string) (json.RawMessage, bool) {
	switch field {
	case overlay.FieldNameCn:
		return mustJSON(trimmed(n.Cn)), true
	case overlay.FieldNameNative:
		return mustJSON(trimmed(n.Native)), true
	case overlay.FieldNameFull:
		return mustJSON(trimmed(n.Full)), true
	}
	return nil, false
}

// sameValue compares an item's old value, as jsonb gave it back, with the
// page's.  A list is its entries in order (no list and an empty one are the
// same).  A voice row is who voices it and the line under the name -- not
// how that person is named or pictured now, which their own page's edits or
// AniList can change without touching the row.
func sameValue(field string, a, b json.RawMessage) bool {
	switch field {
	case overlay.FieldAliases, overlay.FieldOccupations:
		var x, y []string
		if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
			return false
		}
		return slices.Equal(x, y)
	case overlay.FieldVoice:
		var x, y *voiceValue
		if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
			return false
		}
		if x == nil || y == nil {
			return x == nil && y == nil
		}
		return x.PersonID == y.PersonID && sameText(x.Language, y.Language) &&
			sameText(x.RoleNotes, y.RoleNotes) && sameText(x.Line, y.Line)
	}
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}

// staleItems is the items whose old value is no longer the page's.  With no
// page (value nil: it no longer exists) every item is stale.
func staleItems(value pageValue, items []dbgen.ListEditItemsRow) map[uuid.UUID]bool {
	out := map[uuid.UUID]bool{}
	for _, it := range items {
		if value == nil {
			out[it.ID] = true
			continue
		}
		cur, ok := value(it.Field, it.ItemKey)
		if !ok || !sameValue(it.Field, it.OldValue, cur) {
			out[it.ID] = true
		}
	}
	return out
}

// currentPage reads the page a submission is about as it is now, with every
// accepted edit applied: nil when it no longer exists.
func (h *Handlers) currentPage(ctx context.Context, kind string, id int32) (pageValue, error) {
	if overlay.Kind(kind) == overlay.Person {
		p, found, err := people.LoadPerson(ctx, h.q, id)
		if err != nil || !found {
			return nil, err
		}
		return personValue(p), nil
	}
	c, found, err := people.LoadCharacter(ctx, h.q, id)
	if err != nil || !found {
		return nil, err
	}
	return characterValue(c), nil
}
