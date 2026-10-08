// Package credits turns AniList's character and staff connections into
// the rows anime_characters, anime_character_voices and anime_staff hold,
// and writes them.
//
// # Why a package of its own
//
// Two writers fill those tables and they must agree on every rule:
//
//   - the detail refresh (internal/anime), which reads AniList's first
//     page of each list on the request path, at most once a day per title;
//   - the credits sweep (internal/queue), which reads everything after it
//     in the background, up to 400 of each.
//
// internal/anime imports internal/queue, so the rules cannot live in
// either one -- the facts sweep's answer to the same problem was to
// restate NormalizeMainRow's rules in queue, which is tolerable for four
// scalars and is not for the voice selection below.  Both writers call
// into this package instead, the way cmd/bgmbackfill and the episode-title
// sweep share internal/episodetitles.
//
// # What a row is
//
// A character row carries one voice in its voice_actor_* columns -- the
// columns /api/anime/:id has always returned and its consumers decode --
// and every voice the character has goes to anime_character_voices.  Which
// voice is the one is the title's call, not AniList's order: a donghua's
// characters are voiced in Chinese first and dubbed into Japanese later,
// and AniList lists whichever was entered first.  See PrimaryLanguage and
// CastFromEdges.
package credits

import (
	"sort"
	"strings"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
)

// MaxVoicesPerCharacter caps the voice rows kept per character.
//
// A popular character has a voice in every market AniList tracks --
// thirteen roles in ten languages is not unusual -- and nobody reading a
// cast list needs the Thai and Indonesian dubs of every side character.
// Eight keeps the title's own language, the Japanese cast and the larger
// dubs (voices are ordered before the cap, see orderVoices), and bounds a
// 400-character title at 3,200 rows.
const MaxVoicesPerCharacter = 8

// AniList's languageV2 labels for the three languages a primary voice is
// chosen from.  Compared case-insensitively; the label is free text.
const (
	LanguageJapanese = "Japanese"
	LanguageChinese  = "Chinese"
	LanguageKorean   = "Korean"
)

// PrimaryLanguage is the language whose voice a title's character rows
// carry: Chinese for a Chinese or Taiwanese production, Korean for a
// Korean one, Japanese for everything else -- including a title with no
// country recorded, which on AniList is overwhelmingly Japanese.
func PrimaryLanguage(countryOfOrigin *string) string {
	if countryOfOrigin == nil {
		return LanguageJapanese
	}
	switch strings.ToUpper(strings.TrimSpace(*countryOfOrigin)) {
	case "CN", "TW":
		return LanguageChinese
	case "KR":
		return LanguageKorean
	default:
		return LanguageJapanese
	}
}

// Character is one anime_characters row.  DisplayOrder is the position in
// the list the row was built from (the caller's page or whole list).
//
// The voice_actor_* fields name the primary voice (see CastFromEdges).
// VoiceActorJa holds that person's native-script name: Japanese for a
// Japanese actor, Chinese for a Chinese one -- the column was named when
// only Japanese voices were stored.  NameCn is always nil: no source
// fills it yet.
//
// The json tags are the column definition list of UpsertAnimeCharacters,
// which takes a whole list as one jsonb array (see WriteCast); a field
// the statement must not write is tagged "-".
type Character struct {
	DisplayOrder       int32   `json:"display_order"`
	NameEn             *string `json:"name_en"`
	NameJa             *string `json:"name_ja"`
	NameCn             *string `json:"-"`
	ImageUrl           *string `json:"image_url"`
	Role               *string `json:"role"`
	VoiceActorEn       *string `json:"voice_actor_en"`
	VoiceActorJa       *string `json:"voice_actor_ja"`
	VoiceActorImageUrl *string `json:"voice_actor_image_url"`
	// AniList's ids for the character and the primary voice actor.  Nil
	// when AniList's node carried no positive id, which the column CHECK
	// would refuse.
	CharacterID  *int32 `json:"character_id"`
	VoiceActorID *int32 `json:"voice_actor_id"`
}

// Voice is one anime_character_voices row: one person voicing one
// character, in DisplayOrder within that character (0 is the primary
// voice, the same person as the character row's voice_actor_id).  The
// json tags are UpsertAnimeCharacterVoices' column definition list.
type Voice struct {
	CharacterID  int32   `json:"character_id"`
	StaffID      int32   `json:"staff_id"`
	DisplayOrder int32   `json:"display_order"`
	Language     *string `json:"language"`   // languageV2: "Japanese", "Chinese", ...
	RoleNotes    *string `json:"role_notes"` // "Childhood", "Young", ...; nil for a main voice
	DubGroup     *string `json:"dub_group"`
	NameFull     *string `json:"name_full"`
	NameNative   *string `json:"name_native"`
	ImageUrl     *string `json:"image_url"`
}

// Cast is a list of characters with their voices.
type Cast struct {
	Characters []Character
	Voices     []Voice
}

// Staff is one anime_staff row.  The json tags are UpsertAnimeStaff's
// column definition list.
type Staff struct {
	DisplayOrder int32   `json:"display_order"`
	NameEn       *string `json:"name_en"`
	NameJa       *string `json:"name_ja"`
	ImageUrl     *string `json:"image_url"`
	Role         *string `json:"role"`
	StaffID      *int32  `json:"staff_id"` // nil when the node carried no positive id
}

// CastFromEdges builds the character and voice rows for a list of
// character edges -- one page from the detail refresh, or every page the
// sweep fetched, concatenated in order.
//
// A character AniList lists twice (possible only when two requests'
// pages overlap because the list changed between them) is kept at its
// first position; positions are renumbered over what is kept, so
// DisplayOrder is always 0..n-1.
//
// The primary voice -- the one the character row carries -- is chosen in
// this order:
//
//  1. a voice in the title's own language (PrimaryLanguage) with no role
//     notes, i.e. the main voice rather than "Childhood" or "Young";
//  2. any voice in that language;
//  3. the same two steps in Japanese, for a donghua that AniList only has
//     a Japanese cast for;
//  4. the same two steps in any language.
//
// Within each step AniList's order ([RELEVANCE, ID]) breaks ties.  The
// port took voiceActors(language: JAPANESE)[0]; for a Japanese title with
// one voice per character this chooses the same person.
func CastFromEdges(edges []anilist.CharacterEdge, countryOfOrigin *string) Cast {
	want := PrimaryLanguage(countryOfOrigin)
	cast := Cast{Characters: make([]Character, 0, len(edges)), Voices: []Voice{}}
	seen := make(map[int]struct{}, len(edges))

	for _, e := range edges {
		if e.Node.ID > 0 {
			if _, dup := seen[e.Node.ID]; dup {
				continue
			}
			seen[e.Node.ID] = struct{}{}
		}

		c := Character{
			DisplayOrder: int32(len(cast.Characters)),
			ImageUrl:     imageURL(e.Node.Image),
			Role:         e.Role,
			CharacterID:  positiveID(e.Node.ID),
		}
		if e.Node.Name != nil {
			c.NameEn, c.NameJa = e.Node.Name.Full, e.Node.Name.Native
		}

		voices := orderVoices(e.VoiceActorRoles, want)
		if len(voices) > 0 {
			primary := voices[0].VoiceActor
			if primary.Name != nil {
				c.VoiceActorEn, c.VoiceActorJa = primary.Name.Full, primary.Name.Native
			}
			c.VoiceActorImageUrl = imageURL(primary.Image)
			c.VoiceActorID = positiveID(primary.ID)
		}
		cast.Characters = append(cast.Characters, c)

		// A voice row is keyed by the character id; an id-less node keeps
		// its primary voice on the character row and nothing more.
		if c.CharacterID == nil {
			continue
		}
		for i, r := range voices {
			va := r.VoiceActor
			v := Voice{
				CharacterID:  *c.CharacterID,
				StaffID:      int32(va.ID),
				DisplayOrder: int32(i),
				Language:     trimmed(va.LanguageV2),
				RoleNotes:    trimmed(r.RoleNotes),
				DubGroup:     trimmed(r.DubGroup),
				ImageUrl:     imageURL(va.Image),
			}
			if va.Name != nil {
				v.NameFull, v.NameNative = va.Name.Full, va.Name.Native
			}
			cast.Voices = append(cast.Voices, v)
		}
	}
	return cast
}

// orderVoices returns the character's usable voice roles in stored
// order: the primary voice first (see CastFromEdges), then the rest of
// the title's language, then Japanese, then every other language, each
// group in AniList's order; one entry per person; at most
// MaxVoicesPerCharacter.
//
// Grouping before the cap is what keeps a Chinese title's second Chinese
// voice ahead of a character's eighth dub.
func orderVoices(roles []anilist.VoiceActorRole, want string) []anilist.VoiceActorRole {
	usable := make([]anilist.VoiceActorRole, 0, len(roles))
	for _, r := range roles {
		if r.VoiceActor != nil && r.VoiceActor.ID > 0 {
			usable = append(usable, r)
		}
	}
	if len(usable) == 0 {
		return nil
	}

	primary := pickPrimary(usable, want)
	rest := make([]anilist.VoiceActorRole, 0, len(usable)-1)
	for i, r := range usable {
		if i != primary {
			rest = append(rest, r)
		}
	}
	group := func(r anilist.VoiceActorRole) int {
		switch lang := language(r); {
		case strings.EqualFold(lang, want):
			return 0
		case strings.EqualFold(lang, LanguageJapanese):
			return 1
		default:
			return 2
		}
	}
	sort.SliceStable(rest, func(i, j int) bool { return group(rest[i]) < group(rest[j]) })

	out := make([]anilist.VoiceActorRole, 0, min(len(usable), MaxVoicesPerCharacter))
	people := make(map[int]struct{}, len(usable))
	for _, r := range append([]anilist.VoiceActorRole{usable[primary]}, rest...) {
		if len(out) == MaxVoicesPerCharacter {
			break
		}
		if _, dup := people[r.VoiceActor.ID]; dup {
			continue
		}
		people[r.VoiceActor.ID] = struct{}{}
		out = append(out, r)
	}
	return out
}

// pickPrimary returns the index of the primary voice among usable roles
// (non-empty), following the steps CastFromEdges documents.
func pickPrimary(roles []anilist.VoiceActorRole, want string) int {
	for _, lang := range []string{want, LanguageJapanese} {
		if i := firstVoiceIn(roles, lang); i >= 0 {
			return i
		}
	}
	return firstVoiceIn(roles, "")
}

// firstVoiceIn returns the first role in lang ("" for any language) that
// has no role notes, else the first role in lang at all, else -1.
func firstVoiceIn(roles []anilist.VoiceActorRole, lang string) int {
	fallback := -1
	for i, r := range roles {
		if lang != "" && !strings.EqualFold(language(r), lang) {
			continue
		}
		if trimmed(r.RoleNotes) == nil {
			return i
		}
		if fallback < 0 {
			fallback = i
		}
	}
	return fallback
}

// StaffFromEdges builds the staff rows for a list of staff edges.  A
// person appears once per role; an edge repeating a (person, role) pair
// already seen is dropped, so the rows satisfy the table's key, and
// DisplayOrder is renumbered over what is kept.
func StaffFromEdges(edges []anilist.StaffEdge) []Staff {
	type key struct {
		id      int
		role    string
		hasRole bool
	}
	out := make([]Staff, 0, len(edges))
	seen := make(map[key]struct{}, len(edges))
	for _, e := range edges {
		if e.Node.ID > 0 {
			k := key{id: e.Node.ID, hasRole: e.Role != nil}
			if e.Role != nil {
				k.role = *e.Role
			}
			if _, dup := seen[k]; dup {
				continue
			}
			seen[k] = struct{}{}
		}
		s := Staff{
			DisplayOrder: int32(len(out)),
			ImageUrl:     imageURL(e.Node.Image),
			Role:         e.Role,
			StaffID:      positiveID(e.Node.ID),
		}
		if e.Node.Name != nil {
			s.NameEn, s.NameJa = e.Node.Name.Full, e.Node.Name.Native
		}
		out = append(out, s)
	}
	return out
}

// language is a role's trimmed languageV2 label, "" when absent.
func language(r anilist.VoiceActorRole) string {
	if r.VoiceActor == nil || r.VoiceActor.LanguageV2 == nil {
		return ""
	}
	return strings.TrimSpace(*r.VoiceActor.LanguageV2)
}

// imageURL is the image a row stores: medium, the size every credit row
// has always stored, else large when AniList sent only that.
func imageURL(img *anilist.Image) *string {
	if img == nil {
		return nil
	}
	if img.Medium != nil && *img.Medium != "" {
		return img.Medium
	}
	if img.Large != nil && *img.Large != "" {
		return img.Large
	}
	return nil
}

// trimmed returns the value without surrounding space, or nil when that
// leaves nothing: an empty role note is no role note.
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

// positiveID narrows an AniList node id for an id column, and turns the
// decode default (0, for a node whose id was absent) into NULL rather
// than a value the column's CHECK would refuse.
func positiveID(id int) *int32 {
	if id <= 0 {
		return nil
	}
	n := int32(id)
	return &n
}
