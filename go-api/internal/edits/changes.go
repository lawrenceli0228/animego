package edits

import (
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/lawrenceli0228/animego/go-api/internal/overlay"
	"github.com/lawrenceli0228/animego/go-api/internal/people"
)

// Limits, in characters (code points, as the page counts them).  Every
// field has one; the database repeats the ones on the submission itself.
const (
	maxNameLen        = 100
	maxAliasLen       = 100
	maxAliases        = 20
	maxOccupationLen  = 60
	maxOccupations    = 10
	maxGenderLen      = 30
	maxAgeLen         = 30
	maxBloodTypeLen   = 10
	maxHomeTownLen    = 100
	maxDescriptionLen = 20000
	maxLineLen        = 60
	maxVoiceChanges   = 30
	maxRoleChanges    = 100
	maxSourceLen      = 500
	maxNoteLen        = 500
	maxItems          = 50
)

// changeSet is the "changes" object of POST /api/edits: what the submitter
// changed, field by field.  An absent key is a field left alone.  For the
// facts, null clears the value (an Opt set to null); names cannot be
// cleared.
type changeSet struct {
	NameCn      overlay.Opt[string]       `json:"nameCn"`
	NameNative  overlay.Opt[string]       `json:"nameNative"`
	NameFull    overlay.Opt[string]       `json:"nameFull"`
	Aliases     overlay.Opt[[]string]     `json:"aliases"`
	Occupations overlay.Opt[[]string]     `json:"occupations"`
	Gender      overlay.Opt[string]       `json:"gender"`
	Age         overlay.Opt[string]       `json:"age"`
	Birth       overlay.Opt[overlay.Date] `json:"birth"`
	BloodType   overlay.Opt[string]       `json:"bloodType"`
	HomeTown    overlay.Opt[string]       `json:"homeTown"`
	Description overlay.Opt[string]       `json:"description"`
	Image       *imageChange              `json:"image"`
	Voices      []voiceChange             `json:"voices"`
	Roles       []roleChange              `json:"roles"`
}

// imageChange is a new photo: a link to fetch, or an upload as a data URL.
// Exactly one.
type imageChange struct {
	URL     string `json:"url"`
	DataURL string `json:"dataUrl"`
}

// voiceChange edits one of a character's voice rows, named by its key, or
// adds a row (no key).  personId gives the row to someone else, or names
// who the added row is; line is the line under the name.
type voiceChange struct {
	Key      string              `json:"key"`
	Remove   bool                `json:"remove"`
	PersonID *int64              `json:"personId"`
	Line     overlay.Opt[string] `json:"line"`
}

// roleChange is the character's role on one of its titles.
type roleChange struct {
	AnimeID int64  `json:"animeId"`
	Role    string `json:"role"`
}

// changeError is a change the submission cannot make.  It is the submitter's
// (a 400), and names the field so the message says which.
type changeError struct {
	field  string
	reason string
}

func (e *changeError) Error() string { return "invalid change: " + e.field + ": " + e.reason }

func invalid(field, reason string) error { return &changeError{field: field, reason: reason} }

// fieldsFor is which fields each kind of page has.  The person page shows
// occupations and a home town; the character page aliases, an age, a
// description, its voices and a role per title.
var fieldsFor = map[overlay.Kind][]string{
	overlay.Character: {
		overlay.FieldNameCn, overlay.FieldNameNative, overlay.FieldNameFull, overlay.FieldAliases,
		overlay.FieldImage, overlay.FieldGender, overlay.FieldAge, overlay.FieldBirth,
		overlay.FieldBloodType, overlay.FieldDescription, overlay.FieldVoice, overlay.FieldRole,
	},
	overlay.Person: {
		overlay.FieldNameCn, overlay.FieldNameNative, overlay.FieldNameFull, overlay.FieldOccupations,
		overlay.FieldImage, overlay.FieldGender, overlay.FieldBirth, overlay.FieldBloodType,
		overlay.FieldHomeTown,
	},
}

// present lists the fields a change set touches.
func (ch changeSet) present() []string {
	var out []string
	add := func(set bool, field string) {
		if set {
			out = append(out, field)
		}
	}
	add(ch.NameCn.Set, overlay.FieldNameCn)
	add(ch.NameNative.Set, overlay.FieldNameNative)
	add(ch.NameFull.Set, overlay.FieldNameFull)
	add(ch.Aliases.Set, overlay.FieldAliases)
	add(ch.Occupations.Set, overlay.FieldOccupations)
	add(ch.Gender.Set, overlay.FieldGender)
	add(ch.Age.Set, overlay.FieldAge)
	add(ch.Birth.Set, overlay.FieldBirth)
	add(ch.BloodType.Set, overlay.FieldBloodType)
	add(ch.HomeTown.Set, overlay.FieldHomeTown)
	add(ch.Description.Set, overlay.FieldDescription)
	add(ch.Image != nil, overlay.FieldImage)
	add(len(ch.Voices) > 0, overlay.FieldVoice)
	add(len(ch.Roles) > 0, overlay.FieldRole)
	return out
}

// checkApplies refuses a field the kind of page does not have.
func checkApplies(kind overlay.Kind, ch changeSet) error {
	for _, f := range ch.present() {
		if !slices.Contains(fieldsFor[kind], f) {
			return invalid(f, "not on this page")
		}
	}
	return nil
}

// cleanLine is single-line text: trimmed, no control characters, at most
// max characters.
func cleanLine(field, s string, max int) (string, error) {
	s = strings.TrimSpace(s)
	for _, r := range s {
		if unicode.IsControl(r) {
			return "", invalid(field, "control character")
		}
	}
	if utf8.RuneCountInString(s) > max {
		return "", invalid(field, "too long")
	}
	return s, nil
}

// cleanText is multi-line text: line endings as \n, trimmed, no control
// characters but newlines and tabs, at most max characters.
func cleanText(field, s string, max int) (string, error) {
	s = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n"))
	for _, r := range s {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return "", invalid(field, "control character")
		}
	}
	if utf8.RuneCountInString(s) > max {
		return "", invalid(field, "too long")
	}
	return s, nil
}

// cleanName is a name: required once it is changed.
func cleanName(field string, o overlay.Opt[string]) (string, error) {
	if o.Value == nil {
		return "", invalid(field, "a name cannot be cleared")
	}
	s, err := cleanLine(field, *o.Value, maxNameLen)
	if err != nil {
		return "", err
	}
	if s == "" {
		return "", invalid(field, "a name cannot be blank")
	}
	return s, nil
}

// cleanFact is an optional single-line fact: blank or null clears it.
func cleanFact(field string, o overlay.Opt[string], max int) (*string, error) {
	if o.Value == nil {
		return nil, nil
	}
	s, err := cleanLine(field, *o.Value, max)
	if err != nil || s == "" {
		return nil, err
	}
	return &s, nil
}

// cleanList is a list of short labels: each trimmed, blanks and repeats
// dropped, at most maxEach characters each and maxCount in all.  Null is
// the empty list.
func cleanList(field string, o overlay.Opt[[]string], maxEach, maxCount int) ([]string, error) {
	out := []string{}
	if o.Value == nil {
		return out, nil
	}
	for _, s := range *o.Value {
		s, err := cleanLine(field, s, maxEach)
		if err != nil {
			return nil, err
		}
		if s != "" && !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	if len(out) > maxCount {
		return nil, invalid(field, "too many")
	}
	return out, nil
}

// cleanBirth is a birthday: any part may be unknown, but a day needs its
// month and must exist in it (29 February only in a leap year, or with no
// year).  All parts unknown, or null, clears it.
func cleanBirth(o overlay.Opt[overlay.Date]) (*overlay.Date, error) {
	if o.Value == nil {
		return nil, nil
	}
	d := *o.Value
	if d.Year == nil && d.Month == nil && d.Day == nil {
		return nil, nil
	}
	if d.Year != nil && (*d.Year < 1000 || *d.Year > int32(time.Now().Year()+1)) {
		return nil, invalid(overlay.FieldBirth, "year out of range")
	}
	if d.Month != nil && (*d.Month < 1 || *d.Month > 12) {
		return nil, invalid(overlay.FieldBirth, "month out of range")
	}
	if d.Day != nil {
		if d.Month == nil {
			return nil, invalid(overlay.FieldBirth, "a day needs its month")
		}
		year := 2000 // a leap year: 29 February exists when the year is unknown
		if d.Year != nil {
			year = int(*d.Year)
		}
		last := time.Date(year, time.Month(*d.Month)+1, 0, 0, 0, 0, 0, time.UTC).Day()
		if *d.Day < 1 || int(*d.Day) > last {
			return nil, invalid(overlay.FieldBirth, "no such day")
		}
	}
	return &d, nil
}

// cleanSource is the source a submission cites: an http or https link.
func cleanSource(raw string) (string, error) {
	s, err := cleanLine("sourceUrl", raw, maxSourceLen)
	if err != nil {
		return "", err
	}
	if s == "" {
		return "", errSourceRequired
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return "", errSourceInvalid
	}
	return s, nil
}

// cleanNote is the submitter's optional note; blank is none.
func cleanNote(raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	s, err := cleanText("note", *raw, maxNoteLen)
	if err != nil || s == "" {
		return nil, err
	}
	return &s, nil
}

// item is one changed field as edit_items stores it.
type item struct {
	Field string
	Key   string
	Old   json.RawMessage
	New   json.RawMessage
	Meta  json.RawMessage
}

func mustJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("edits: marshal %T: %v", v, err))
	}
	return raw
}

func trimmed(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		return nil
	}
	return &t
}

func sameText(a, b *string) bool {
	a, b = trimmed(a), trimmed(b)
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sameDate(a *people.FuzzyDate, b *overlay.Date) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	eq := func(x, y *int32) bool { return (x == nil && y == nil) || (x != nil && y != nil && *x == *y) }
	return eq(a.Year, b.Year) && eq(a.Month, b.Month) && eq(a.Day, b.Day)
}

// textItem adds a single-line field when it changes.
func textItem(items []item, field string, old, next *string) []item {
	if sameText(old, next) {
		return items
	}
	return append(items, item{Field: field, Old: mustJSON(trimmed(old)), New: mustJSON(next)})
}

// voiceValue is a voice row as an item shows it: who, and the line under
// the name (the credit's language and notes for an unedited row).
type voiceValue struct {
	PersonID  int32       `json:"personId"`
	Name      people.Name `json:"name"`
	Image     *string     `json:"image"`
	Language  *string     `json:"language"`
	RoleNotes *string     `json:"roleNotes"`
	Line      *string     `json:"line"`
}

func voiceValueOf(v people.CharacterVoice) voiceValue {
	return voiceValue{
		PersonID: v.Person.AnilistID, Name: v.Person.Name, Image: v.Person.Image,
		Language: v.Language, RoleNotes: v.RoleNotes, Line: v.Line,
	}
}

// voicePeopleIn is the people a set of voice changes names.
func voicePeopleIn(changes []voiceChange) []int32 {
	var out []int32
	for _, v := range changes {
		if v.PersonID != nil && *v.PersonID > 0 && *v.PersonID <= int64(^uint32(0)>>1) {
			id := int32(*v.PersonID)
			if !slices.Contains(out, id) {
				out = append(out, id)
			}
		}
	}
	return out
}

// diffVoices turns voice changes into items.  refs names everyone a change
// gives a row to (and must, for a change to stand: an id the database does
// not credit is refused).
func diffVoices(current []people.CharacterVoice, changes []voiceChange, refs map[int32]people.PersonRef) ([]item, error) {
	if len(changes) > maxVoiceChanges {
		return nil, invalid(overlay.FieldVoice, "too many")
	}
	byKey := map[string]people.CharacterVoice{}
	for _, v := range current {
		byKey[v.Key] = v
	}
	person := func(id *int64) (people.PersonRef, error) {
		if id == nil || *id <= 0 || *id > int64(^uint32(0)>>1) {
			return people.PersonRef{}, invalid(overlay.FieldVoice, "no such person")
		}
		ref, ok := refs[int32(*id)]
		if !ok {
			return people.PersonRef{}, invalid(overlay.FieldVoice, "no such person")
		}
		return ref, nil
	}

	var items []item
	seen := map[string]bool{}
	for _, ch := range changes {
		var line *string
		if ch.Line.Set && ch.Line.Value != nil {
			l, err := cleanLine(overlay.FieldVoice, *ch.Line.Value, maxLineLen)
			if err != nil {
				return nil, err
			}
			if l != "" {
				line = &l
			}
		}

		if ch.Key == "" { // a row added
			if ch.Remove {
				return nil, invalid(overlay.FieldVoice, "nothing to remove")
			}
			ref, err := person(ch.PersonID)
			if err != nil {
				return nil, err
			}
			key := overlay.AddedVoiceKey(ref.AnilistID)
			if _, listed := byKey[key]; listed || seen[key] {
				return nil, invalid(overlay.FieldVoice, "already listed")
			}
			seen[key] = true
			items = append(items, item{
				Field: overlay.FieldVoice, Key: key, Old: mustJSON(nil),
				New: mustJSON(voiceValue{PersonID: ref.AnilistID, Name: ref.Name, Image: ref.Image, Line: line}),
			})
			continue
		}

		cur, ok := byKey[ch.Key]
		if !ok {
			return nil, invalid(overlay.FieldVoice, "no such row")
		}
		if seen[ch.Key] {
			return nil, invalid(overlay.FieldVoice, "a row changed twice")
		}
		seen[ch.Key] = true
		old := voiceValueOf(cur)
		if ch.Remove {
			items = append(items, item{Field: overlay.FieldVoice, Key: ch.Key, Old: mustJSON(old), New: mustJSON(nil)})
			continue
		}
		next := old
		if ch.PersonID != nil && *ch.PersonID != int64(cur.Person.AnilistID) {
			ref, err := person(ch.PersonID)
			if err != nil {
				return nil, err
			}
			next.PersonID, next.Name, next.Image = ref.AnilistID, ref.Name, ref.Image
		}
		if ch.Line.Set {
			next.Line = line
		}
		if next.PersonID == old.PersonID && sameText(next.Line, old.Line) {
			continue
		}
		items = append(items, item{Field: overlay.FieldVoice, Key: ch.Key, Old: mustJSON(old), New: mustJSON(next)})
	}
	return items, nil
}

// diffRoles turns role changes into items, one per title whose role
// actually changes; meta carries the title for the review.
func diffRoles(apps []people.Appearance, changes []roleChange) ([]item, error) {
	if len(changes) > maxRoleChanges {
		return nil, invalid(overlay.FieldRole, "too many")
	}
	var items []item
	seen := map[int64]bool{}
	for _, ch := range changes {
		if !slices.Contains(overlay.Roles, ch.Role) {
			return nil, invalid(overlay.FieldRole, "unknown role")
		}
		i := slices.IndexFunc(apps, func(a people.Appearance) bool { return int64(a.Anime.AnilistID) == ch.AnimeID })
		if i < 0 {
			return nil, invalid(overlay.FieldRole, "not one of its titles")
		}
		if seen[ch.AnimeID] {
			return nil, invalid(overlay.FieldRole, "a title changed twice")
		}
		seen[ch.AnimeID] = true
		role := ch.Role
		if sameText(apps[i].Role, &role) {
			continue
		}
		items = append(items, item{
			Field: overlay.FieldRole,
			Key:   strconv.FormatInt(ch.AnimeID, 10),
			Old:   mustJSON(apps[i].Role),
			New:   mustJSON(role),
			Meta:  mustJSON(map[string]any{"work": apps[i].Anime}),
		})
	}
	return items, nil
}

// diffNames adds the three names that change.
func diffNames(items []item, current people.Name, ch changeSet) ([]item, error) {
	for _, n := range []struct {
		field string
		opt   overlay.Opt[string]
		old   *string
	}{
		{overlay.FieldNameCn, ch.NameCn, current.Cn},
		{overlay.FieldNameNative, ch.NameNative, current.Native},
		{overlay.FieldNameFull, ch.NameFull, current.Full},
	} {
		if !n.opt.Set {
			continue
		}
		s, err := cleanName(n.field, n.opt)
		if err != nil {
			return nil, err
		}
		items = textItem(items, n.field, n.old, &s)
	}
	return items, nil
}

// diffCharacter is every item a change set makes on a character page as it
// is shown now, in the page's order.  The photo is not among them: it is
// stored first, and the handler adds its item.
func diffCharacter(c *people.Character, ch changeSet, refs map[int32]people.PersonRef) ([]item, error) {
	if err := checkApplies(overlay.Character, ch); err != nil {
		return nil, err
	}
	items, err := diffNames(nil, c.Name, ch)
	if err != nil {
		return nil, err
	}
	if ch.Aliases.Set {
		next, err := cleanList(overlay.FieldAliases, ch.Aliases, maxAliasLen, maxAliases)
		if err != nil {
			return nil, err
		}
		if !slices.Equal(next, c.AlternativeNames) {
			items = append(items, item{Field: overlay.FieldAliases, Old: mustJSON(c.AlternativeNames), New: mustJSON(next)})
		}
	}
	profile := c.Profile
	if profile == nil {
		profile = &people.CharacterProfile{}
	}
	if ch.Gender.Set {
		next, err := cleanFact(overlay.FieldGender, ch.Gender, maxGenderLen)
		if err != nil {
			return nil, err
		}
		items = textItem(items, overlay.FieldGender, profile.Gender, next)
	}
	if ch.Age.Set {
		next, err := cleanFact(overlay.FieldAge, ch.Age, maxAgeLen)
		if err != nil {
			return nil, err
		}
		items = textItem(items, overlay.FieldAge, profile.Age, next)
	}
	if ch.Birth.Set {
		next, err := cleanBirth(ch.Birth)
		if err != nil {
			return nil, err
		}
		if !sameDate(profile.Birth, next) {
			items = append(items, item{Field: overlay.FieldBirth, Old: mustJSON(profile.Birth), New: mustJSON(next)})
		}
	}
	if ch.BloodType.Set {
		next, err := cleanFact(overlay.FieldBloodType, ch.BloodType, maxBloodTypeLen)
		if err != nil {
			return nil, err
		}
		items = textItem(items, overlay.FieldBloodType, profile.BloodType, next)
	}
	if ch.Description.Set {
		var next *string
		if ch.Description.Value != nil {
			s, err := cleanText(overlay.FieldDescription, *ch.Description.Value, maxDescriptionLen)
			if err != nil {
				return nil, err
			}
			if s != "" {
				next = &s
			}
		}
		items = textItem(items, overlay.FieldDescription, profile.Description, next)
	}
	voices, err := diffVoices(c.Voices, ch.Voices, refs)
	if err != nil {
		return nil, err
	}
	roles, err := diffRoles(c.Appearances, ch.Roles)
	if err != nil {
		return nil, err
	}
	return append(append(items, voices...), roles...), nil
}

// diffPerson is diffCharacter for a person page.
func diffPerson(p *people.Person, ch changeSet) ([]item, error) {
	if err := checkApplies(overlay.Person, ch); err != nil {
		return nil, err
	}
	items, err := diffNames(nil, p.Name, ch)
	if err != nil {
		return nil, err
	}
	profile := p.Profile
	if profile == nil {
		profile = &people.PersonProfile{Occupations: []string{}}
	}
	if ch.Occupations.Set {
		next, err := cleanList(overlay.FieldOccupations, ch.Occupations, maxOccupationLen, maxOccupations)
		if err != nil {
			return nil, err
		}
		if !slices.Equal(next, profile.Occupations) {
			items = append(items, item{Field: overlay.FieldOccupations, Old: mustJSON(profile.Occupations), New: mustJSON(next)})
		}
	}
	if ch.Gender.Set {
		next, err := cleanFact(overlay.FieldGender, ch.Gender, maxGenderLen)
		if err != nil {
			return nil, err
		}
		items = textItem(items, overlay.FieldGender, profile.Gender, next)
	}
	if ch.Birth.Set {
		next, err := cleanBirth(ch.Birth)
		if err != nil {
			return nil, err
		}
		if !sameDate(profile.Birth, next) {
			items = append(items, item{Field: overlay.FieldBirth, Old: mustJSON(profile.Birth), New: mustJSON(next)})
		}
	}
	if ch.HomeTown.Set {
		next, err := cleanFact(overlay.FieldHomeTown, ch.HomeTown, maxHomeTownLen)
		if err != nil {
			return nil, err
		}
		items = textItem(items, overlay.FieldHomeTown, profile.HomeTown, next)
	}
	if ch.BloodType.Set {
		next, err := cleanFact(overlay.FieldBloodType, ch.BloodType, maxBloodTypeLen)
		if err != nil {
			return nil, err
		}
		items = textItem(items, overlay.FieldBloodType, profile.BloodType, next)
	}
	return items, nil
}

// checkImage validates the shape of a photo change: one of the two ways,
// within its length.
func checkImage(img *imageChange) error {
	if img == nil {
		return nil
	}
	hasURL, hasData := strings.TrimSpace(img.URL) != "", strings.TrimSpace(img.DataURL) != ""
	if hasURL == hasData {
		return invalid(overlay.FieldImage, "a link or an upload, one of them")
	}
	if hasURL && len(img.URL) > maxImageURLLen {
		return invalid(overlay.FieldImage, "link too long")
	}
	return nil
}
