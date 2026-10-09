// Package overlay is the layer reader edits are read from.
//
// For each person or character an admin has accepted edits for there is one
// row in entity_overlays (migration 0047) holding a Doc: the accepted values,
// field by field.  Every read applies it over the values AniList and Bangumi
// gave -- overlay, then Bangumi's Chinese name, then AniList -- and nothing
// that refreshes from upstream ever writes it, so an accepted edit outlives
// every refresh of the rows beneath it.
//
// The type and its merge rules live here, apart from the readers
// (internal/people, internal/anime) and the writer (internal/edits), so the
// three agree on one spelling of every field.
package overlay

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// Kind is whose page an overlay or a submission is about.
type Kind string

const (
	// Character is an AniList Character id.
	Character Kind = "character"
	// Person is an AniList Staff id: a voice actor, staff, or both.
	Person Kind = "person"
)

// The fields an overlay can set, under the names the submission items and
// the JSON document use.
const (
	FieldNameCn      = "nameCn"
	FieldNameNative  = "nameNative"
	FieldNameFull    = "nameFull"
	FieldAliases     = "aliases"
	FieldOccupations = "occupations"
	FieldImage       = "image"
	FieldGender      = "gender"
	FieldAge         = "age"
	FieldBirth       = "birth"
	FieldBloodType   = "bloodType"
	FieldHomeTown    = "homeTown"
	FieldDescription = "description"
	// FieldVoice is one row of a character's voices, keyed by VoiceKey or
	// AddedVoiceKey.
	FieldVoice = "voice"
	// FieldRole is a character's role on one title, keyed by the title's id.
	FieldRole = "role"
)

var allFields = []string{
	FieldNameCn, FieldNameNative, FieldNameFull, FieldAliases, FieldOccupations,
	FieldImage, FieldGender, FieldAge, FieldBirth, FieldBloodType, FieldHomeTown,
	FieldDescription, FieldVoice, FieldRole,
}

// ValidField reports whether name is a field an overlay can carry.
func ValidField(name string) bool { return slices.Contains(allFields, name) }

// Roles are AniList's three, the values a role overlay may hold.
var Roles = []string{"MAIN", "SUPPORTING", "BACKGROUND"}

// Opt is a field an overlay may hold: not set at all, set to a value, or set
// to null -- a fact an admin agreed should be cleared.  In JSON an unset Opt
// is an absent key (omitzero), a cleared one is null.
type Opt[T any] struct {
	Set   bool
	Value *T
}

// Of is an Opt set to v.
func Of[T any](v T) Opt[T] { return Opt[T]{Set: true, Value: &v} }

// Cleared is an Opt set to null.
func Cleared[T any]() Opt[T] { return Opt[T]{Set: true} }

// IsZero is what encoding/json's omitzero asks: an unset Opt is left out.
func (o Opt[T]) IsZero() bool { return !o.Set }

// MarshalJSON writes the value, or null.
func (o Opt[T]) MarshalJSON() ([]byte, error) {
	if o.Value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*o.Value)
}

// UnmarshalJSON runs only for a key that is present, which is what makes it
// set; null sets it to no value.
func (o *Opt[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		o.Value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}

// Date is a birthday as AniList keeps one, part by part: most are a month
// and a day with no year.
type Date struct {
	Year  *int32 `json:"year"`
	Month *int32 `json:"month"`
	Day   *int32 `json:"day"`
}

// VoiceOp is one accepted change to a character's voices.  Key names the row
// it changes: VoiceKey for a row the credits list, AddedVoiceKey for a row an
// edit added.  Remove drops the row; otherwise PersonID is who voices it now
// and Line, when set, is the line shown under the name in place of the
// language and AniList's notes.
type VoiceOp struct {
	Key      string  `json:"key"`
	Remove   bool    `json:"remove,omitempty"`
	PersonID int32   `json:"personId,omitempty"`
	Line     *string `json:"line,omitempty"`
}

// Doc is one person's or character's accepted values.  Which fields apply
// depends on the kind (a person has no aliases or description here, a
// character no occupations or home town); the submission handler enforces
// that, and a reader ignores what it does not show.
type Doc struct {
	NameCn      Opt[string]   `json:"nameCn,omitzero"`
	NameNative  Opt[string]   `json:"nameNative,omitzero"`
	NameFull    Opt[string]   `json:"nameFull,omitzero"`
	Image       Opt[string]   `json:"image,omitzero"`
	Aliases     Opt[[]string] `json:"aliases,omitzero"`
	Occupations Opt[[]string] `json:"occupations,omitzero"`
	Gender      Opt[string]   `json:"gender,omitzero"`
	Age         Opt[string]   `json:"age,omitzero"`
	Birth       Opt[Date]     `json:"birth,omitzero"`
	BloodType   Opt[string]   `json:"bloodType,omitzero"`
	HomeTown    Opt[string]   `json:"homeTown,omitzero"`
	Description Opt[string]   `json:"description,omitzero"`
	// Voices are applied in order; one op per row.
	Voices []VoiceOp `json:"voices,omitempty"`
	// Roles maps a title's AniList id, as a string, to the character's role
	// there.
	Roles map[string]string `json:"roles,omitempty"`
}

// Decode reads a stored overlay.  Empty input is an empty Doc.  Keys this
// build does not know are ignored, so a document a newer build wrote does
// not take a page down.
func Decode(raw json.RawMessage) (Doc, error) {
	var doc Doc
	if len(bytes.TrimSpace(raw)) == 0 {
		return doc, nil
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return Doc{}, fmt.Errorf("overlay: decode: %w", err)
	}
	return doc, nil
}

// IsEmpty reports whether the document sets nothing.
func (d Doc) IsEmpty() bool {
	return !d.NameCn.Set && !d.NameNative.Set && !d.NameFull.Set && !d.Image.Set &&
		!d.Aliases.Set && !d.Occupations.Set && !d.Gender.Set && !d.Age.Set &&
		!d.Birth.Set && !d.BloodType.Set && !d.HomeTown.Set && !d.Description.Set &&
		len(d.Voices) == 0 && len(d.Roles) == 0
}

// VoiceOp returns the op for a voice row, if there is one.
func (d Doc) VoiceOp(key string) (VoiceOp, bool) {
	for _, op := range d.Voices {
		if op.Key == key {
			return op, true
		}
	}
	return VoiceOp{}, false
}

// Role returns the accepted role on a title, if there is one.
func (d Doc) Role(animeID int32) (string, bool) {
	role, ok := d.Roles[strconv.FormatInt(int64(animeID), 10)]
	return role, ok
}

// voiceValue is a voice item's proposed value as edit_items stores it: who
// voices the row and the line under the name.  The stored item carries the
// person's names and image too, for the review; only these two are kept.
type voiceValue struct {
	PersonID int32   `json:"personId"`
	Line     *string `json:"line"`
}

// With returns a copy of d with one accepted item applied: field and key as
// the item names them, value its proposed value (JSON).  d is not changed.
func (d Doc) With(field, key string, value json.RawMessage) (Doc, error) {
	next := d.clone()
	isNull := bytes.Equal(bytes.TrimSpace(value), []byte("null"))
	var err error
	switch field {
	case FieldNameCn:
		next.NameCn, err = name(value, isNull)
	case FieldNameNative:
		next.NameNative, err = name(value, isNull)
	case FieldNameFull:
		next.NameFull, err = name(value, isNull)
	case FieldImage:
		next.Image, err = name(value, isNull)
	case FieldAliases:
		next.Aliases, err = decodeOpt[[]string](value)
	case FieldOccupations:
		next.Occupations, err = decodeOpt[[]string](value)
	case FieldGender:
		next.Gender, err = decodeOpt[string](value)
	case FieldAge:
		next.Age, err = decodeOpt[string](value)
	case FieldBirth:
		next.Birth, err = decodeOpt[Date](value)
	case FieldBloodType:
		next.BloodType, err = decodeOpt[string](value)
	case FieldHomeTown:
		next.HomeTown, err = decodeOpt[string](value)
	case FieldDescription:
		next.Description, err = decodeOpt[string](value)
	case FieldVoice:
		next.Voices, err = withVoice(next.Voices, key, value, isNull)
	case FieldRole:
		next.Roles, err = withRole(next.Roles, key, value)
	default:
		return Doc{}, fmt.Errorf("overlay: unknown field %q", field)
	}
	if err != nil {
		return Doc{}, fmt.Errorf("overlay: %s: %w", field, err)
	}
	return next, nil
}

// clone copies the parts of d that are shared by reference.
func (d Doc) clone() Doc {
	next := d
	next.Voices = slices.Clone(d.Voices)
	if d.Roles != nil {
		next.Roles = make(map[string]string, len(d.Roles))
		for k, v := range d.Roles {
			next.Roles[k] = v
		}
	}
	return next
}

// name is a field that is always a non-empty string: names and the image.
func name(value json.RawMessage, isNull bool) (Opt[string], error) {
	if isNull {
		return Opt[string]{}, errors.New("cannot be cleared")
	}
	var s string
	if err := json.Unmarshal(value, &s); err != nil {
		return Opt[string]{}, err
	}
	if strings.TrimSpace(s) == "" {
		return Opt[string]{}, errors.New("cannot be blank")
	}
	return Of(s), nil
}

func decodeOpt[T any](value json.RawMessage) (Opt[T], error) {
	var o Opt[T]
	if err := o.UnmarshalJSON(value); err != nil {
		return Opt[T]{}, err
	}
	return o, nil
}

func withVoice(ops []VoiceOp, key string, value json.RawMessage, isNull bool) ([]VoiceOp, error) {
	if key == "" {
		return nil, errors.New("a voice op needs its row's key")
	}
	op := VoiceOp{Key: key}
	if isNull {
		op.Remove = true
	} else {
		var v voiceValue
		if err := json.Unmarshal(value, &v); err != nil {
			return nil, err
		}
		if v.PersonID <= 0 {
			return nil, errors.New("a kept voice names its person")
		}
		op.PersonID = v.PersonID
		op.Line = v.Line
	}
	if i := slices.IndexFunc(ops, func(o VoiceOp) bool { return o.Key == key }); i >= 0 {
		ops[i] = op
		return ops, nil
	}
	return append(ops, op), nil
}

func withRole(roles map[string]string, key string, value json.RawMessage) (map[string]string, error) {
	if id, err := strconv.ParseInt(key, 10, 32); err != nil || id <= 0 {
		return nil, fmt.Errorf("bad title id %q", key)
	}
	var role string
	if err := json.Unmarshal(value, &role); err != nil {
		return nil, err
	}
	if !slices.Contains(Roles, role) {
		return nil, fmt.Errorf("unknown role %q", role)
	}
	if roles == nil {
		roles = map[string]string{}
	}
	roles[key] = role
	return roles, nil
}

// VoiceKey names a voice row the credits list: the person, the language and
// AniList's notes, which is the identity the character page dedupes voices
// by (one row per person, language and note).
func VoiceKey(personID int32, language, notes *string) string {
	lang, note := "", ""
	if language != nil {
		lang = strings.TrimSpace(*language)
	}
	if notes != nil {
		note = strings.TrimSpace(*notes)
	}
	return strconv.FormatInt(int64(personID), 10) + "|" + lang + "|" + note
}

const addedPrefix = "add:"

// AddedVoiceKey names a voice row an edit added.
func AddedVoiceKey(personID int32) string {
	return addedPrefix + strconv.FormatInt(int64(personID), 10)
}

// AddedVoicePerson reads the person out of an AddedVoiceKey.
func AddedVoicePerson(key string) (int32, bool) {
	rest, ok := strings.CutPrefix(key, addedPrefix)
	if !ok {
		return 0, false
	}
	id, err := strconv.ParseInt(rest, 10, 32)
	if err != nil || id <= 0 {
		return 0, false
	}
	return int32(id), true
}
