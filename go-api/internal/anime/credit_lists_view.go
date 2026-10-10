// credit_lists_view.go — what the 角色 and 制作 tabs are told about a
// title, built from its credit rows.  Pure: no database, no HTTP.  The
// handlers in credit_lists.go load the rows (and cache what this builds);
// this file decides what a reader sees.
package anime

import (
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/lawrenceli0228/animego/go-api/internal/bgmnames"
	"github.com/lawrenceli0228/animego/go-api/internal/credits"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// castLang is a dub language the characters tab answers in.  The store
// keeps Japanese voices only (credits.keptLanguage), so there is one: 日配.
// The type stays because the wire still names the language a response's
// voices are in and counts the characters voiced in it, and those fields
// keep their shape for the clients that decode them.
type castLang string

const castLangJa castLang = "ja"

// castLangs is what the tab offers and counts: Japanese alone.
var castLangs = []castLang{castLangJa}

// retiredCastLangs are the codes the dub switch offered while the store
// kept Chinese and Korean voices too (中配 / 韩配).  A link, a cached page
// or a client that still names one is answered in Japanese rather than
// refused: a 400 would break a page that worked yesterday, for a choice
// that no longer exists.
var retiredCastLangs = []string{"zh", "ko"}

// castLangFromLabel maps AniList's languageV2 label, which is free text
// and compared case-insensitively everywhere else too, to its code.  Only
// Japanese has one.  A row in any other language -- one a binary older
// than the Japanese-only rule wrote -- is not listed, counted or searched.
func castLangFromLabel(label *string) (castLang, bool) {
	if label != nil && strings.EqualFold(strings.TrimSpace(*label), credits.LanguageJapanese) {
		return castLangJa, true
	}
	return "", false
}

// parseCastLang reads the `lang` query parameter, in any case: ja, or one
// of retiredCastLangs, which reads as ja.
func parseCastLang(s string) (castLang, bool) {
	code := strings.ToLower(strings.TrimSpace(s))
	if code == string(castLangJa) || slices.Contains(retiredCastLangs, code) {
		return castLangJa, true
	}
	return "", false
}

// Character roles, as AniList spells them.
const (
	castRoleMain       = "MAIN"
	castRoleSupporting = "SUPPORTING"
	castRoleBackground = "BACKGROUND"
)

// castVoice is one person voicing one character, in the language the
// response names.  NameFull / NameNative rather than the _en / _ja of the
// older shapes because anime_character_voices names them so: the table
// was built when it also held Chinese and Korean voices, whose native
// names are not Japanese, and the wire keeps the names it shipped with.
// NameCn is Bangumi's.
type castVoice struct {
	StaffID    *int32  `json:"staffId"`
	NameFull   *string `json:"nameFull"`
	NameNative *string `json:"nameNative"`
	NameCn     *string `json:"nameCn"`
	ImageUrl   *string `json:"imageUrl"`
	// "Childhood", "Young", ...; null for a character's main voice.
	RoleNotes *string `json:"roleNotes"`
	DubGroup  *string `json:"dubGroup"`
}

// castCharacter is one element of /api/anime/:id/characters' data array.
// The character's own fields are named as /api/anime/:id names them, so a
// client that renders one renders the other.  Voices are the character's
// voices in the response's language, main voice first; [] when it has
// none in that language.
type castCharacter struct {
	CharacterID *int32      `json:"characterId"`
	Role        *string     `json:"role"`
	NameEn      *string     `json:"nameEn"`
	NameJa      *string     `json:"nameJa"`
	NameCn      *string     `json:"nameCn"`
	ImageUrl    *string     `json:"imageUrl"`
	Voices      []castVoice `json:"voices"`
}

// castRoleCounts is the role filter's numbers.  All counts every
// character, including a row whose role AniList left empty, which is in
// no role of its own.
type castRoleCounts struct {
	All        int `json:"all"`
	Main       int `json:"main"`
	Supporting int `json:"supporting"`
	Background int `json:"background"`
}

func (c *castRoleCounts) add(role string) {
	c.All++
	switch role {
	case castRoleMain:
		c.Main++
	case castRoleSupporting:
		c.Supporting++
	case castRoleBackground:
		c.Background++
	}
}

// castLangCount is one entry of counts.languages, which the dub switch was
// drawn from: how many characters have a voice in that language.  There
// is at most one now, Japanese.
type castLangCount struct {
	Language string `json:"language"`
	Count    int    `json:"count"`
}

type castCounts struct {
	Roles     castRoleCounts  `json:"roles"`
	Languages []castLangCount `json:"languages"`
}

// castEntry is one character as the list holds it: the wire fields, the
// voices by language, and the normalised names a search reads.
type castEntry struct {
	character castCharacter // Voices unset; a page fills in one language
	role      string        // upper-cased; "" when the row has none
	voices    map[castLang][]castVoice
	// names and voiceNames are bgmnames.Normalize'd names joined by NUL,
	// which normalizeCastNeedle removes from what a reader types, so a
	// match can never straddle two names.
	names      string
	voiceNames map[castLang]string
}

func (e *castEntry) matches(lang castLang, needle string) bool {
	if needle == "" {
		return true
	}
	return strings.Contains(e.names, needle) || strings.Contains(e.voiceNames[lang], needle)
}

// castList is a whole title's cast, built once per load and shared by
// every request that reads it until it is evicted.  Nothing mutates it
// after buildCastList returns, and its slices are clipped to their length,
// so a caller that appends to one copies it rather than writing into the
// cached array.
type castList struct {
	entries    []castEntry
	langCounts []castLangCount
}

// castQuery is one request's view of the list.  role is "" or one of the
// three role constants; lang "" means Japanese, the only language there
// is; needle is already normalised.
type castQuery struct {
	role   string
	lang   castLang
	needle string
	offset int
	limit  int
}

// castPage is what a request answers.
type castPage struct {
	Data     []castCharacter
	Total    int
	Offset   int
	Limit    int
	HasMore  bool
	Language castLang
	Counts   castCounts
}

// buildCastList puts a title's character and voice rows together.
//
// A character's voices come from anime_character_voices.  When that table
// names none for the character -- a title written before 0042, a row with
// no AniList id (the table cannot key it), or a refresh caught between
// pruning a character's voices and writing them again -- the voice the
// character row itself carries stands in, filed as Japanese, which is
// what every writer has put there: the code before 0042 stored
// voiceActors(language: JAPANESE)[0], the code since 0050 stores the
// Japanese primary or nothing, and 0050 moved the rows written in between
// to their Japanese voice or to none.
func buildCastList(chars []dbgen.ListAnimeCastCharactersRow, voices []dbgen.ListAnimeCastVoicesRow) *castList {
	byCharacter := make(map[int32][]dbgen.ListAnimeCastVoicesRow, len(chars))
	for _, v := range voices {
		byCharacter[v.CharacterID] = append(byCharacter[v.CharacterID], v)
	}

	entries := make([]castEntry, 0, len(chars))
	for _, c := range chars {
		var rows []dbgen.ListAnimeCastVoicesRow
		if c.CharacterID != nil {
			rows = byCharacter[*c.CharacterID]
		}
		byLang := voicesByLanguage(c, rows)
		voiceNames := make(map[castLang]string, len(byLang))
		for lang, vs := range byLang {
			parts := make([]*string, 0, 3*len(vs))
			for _, v := range vs {
				parts = append(parts, v.NameFull, v.NameNative, v.NameCn)
			}
			voiceNames[lang] = joinNormalized(parts...)
		}
		entries = append(entries, castEntry{
			character: castCharacter{
				CharacterID: c.CharacterID,
				Role:        c.Role,
				NameEn:      c.NameEn,
				NameJa:      c.NameJa,
				NameCn:      c.NameCn,
				ImageUrl:    c.ImageUrl,
			},
			role:       strings.ToUpper(strings.TrimSpace(derefStr(c.Role))),
			voices:     byLang,
			names:      joinNormalized(c.NameEn, c.NameJa, c.NameCn),
			voiceNames: voiceNames,
		})
	}

	langCounts := make([]castLangCount, 0, len(castLangs))
	for _, lang := range castLangs {
		n := 0
		for i := range entries {
			if len(entries[i].voices[lang]) > 0 {
				n++
			}
		}
		if n > 0 {
			langCounts = append(langCounts, castLangCount{Language: string(lang), Count: n})
		}
	}
	return &castList{
		entries:    entries,
		langCounts: slices.Clip(langCounts),
	}
}

// voicesByLanguage files one character's voices by language, keeping the
// stored order.  Japanese is the only language with a code; a voice in any
// other is left out.  When the table has no voice for the character, the
// row's own voice stands in as Japanese (see buildCastList).
func voicesByLanguage(c dbgen.ListAnimeCastCharactersRow, rows []dbgen.ListAnimeCastVoicesRow) map[castLang][]castVoice {
	out := make(map[castLang][]castVoice, len(castLangs))
	if len(rows) == 0 {
		if c.VoiceActorEn == nil && c.VoiceActorJa == nil {
			return out
		}
		out[castLangJa] = []castVoice{{
			StaffID:    c.VoiceActorID,
			NameFull:   c.VoiceActorEn,
			NameNative: c.VoiceActorJa,
			NameCn:     c.VoiceActorCn,
			ImageUrl:   c.VoiceActorImageUrl,
		}}
		return out
	}
	for _, v := range rows {
		lang, ok := castLangFromLabel(v.Language)
		if !ok {
			continue
		}
		nameCn := v.NameCn
		// The primary voice keeps the Chinese name its character row holds
		// when Bangumi has none, as GetAnimeCharactersByID answers it.
		if nameCn == nil && c.VoiceActorID != nil && *c.VoiceActorID == v.StaffID {
			nameCn = c.VoiceActorCn
		}
		staffID := v.StaffID
		out[lang] = append(out[lang], castVoice{
			StaffID:    &staffID,
			NameFull:   v.NameFull,
			NameNative: v.NameNative,
			NameCn:     nameCn,
			ImageUrl:   v.ImageUrl,
			RoleNotes:  v.RoleNotes,
			DubGroup:   v.DubGroup,
		})
	}
	for lang, vs := range out {
		out[lang] = slices.Clip(vs)
	}
	return out
}

// page filters, counts and slices the list for one request.
//
// The role counts follow the search but not the role filter, so each
// chip says how many characters choosing it would list.  The language
// counts are the title's, whatever is asked: how many characters have a
// Japanese voice does not change with the search box.
func (l *castList) page(q castQuery) castPage {
	lang := q.lang
	if lang == "" {
		lang = castLangJa
	}

	var roles castRoleCounts
	matched := make([]*castEntry, 0, len(l.entries))
	for i := range l.entries {
		e := &l.entries[i]
		if !e.matches(lang, q.needle) {
			continue
		}
		roles.add(e.role)
		if q.role != "" && e.role != q.role {
			continue
		}
		matched = append(matched, e)
	}

	total := len(matched)
	start := min(max(q.offset, 0), total)
	end := min(start+max(q.limit, 0), total)
	data := make([]castCharacter, 0, end-start)
	for _, e := range matched[start:end] {
		c := e.character
		c.Voices = e.voices[lang]
		if c.Voices == nil {
			c.Voices = []castVoice{}
		}
		data = append(data, c)
	}

	return castPage{
		Data:     data,
		Total:    total,
		Offset:   q.offset,
		Limit:    q.limit,
		HasMore:  end < total,
		Language: lang,
		Counts:   castCounts{Roles: roles, Languages: l.langCounts},
	}
}

// normalizeCastNeedle is what a reader typed, in the form the names are
// indexed in: bgmnames.Normalize (NFKC, the variant kanji, no spaces or
// middle dots, lower case), and no control characters -- the index joins
// names with NUL.
func normalizeCastNeedle(q string) string {
	n := bgmnames.Normalize(q)
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, n)
}

func joinNormalized(names ...*string) string {
	parts := make([]string, 0, len(names))
	for _, n := range names {
		if n == nil {
			continue
		}
		if s := bgmnames.Normalize(*n); s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, "\x00")
}

// staffCredit is one element of /api/anime/:id/staff's data array: one
// person in one role, as anime_staff stores it.  Role is AniList's free
// text, qualifiers included ("Storyboard (eps 1, 2)"); which department
// a role belongs to, and its Chinese label, are the client's to decide,
// next to the label tables it already has.
type staffCredit struct {
	StaffID  *int32  `json:"staffId"`
	Role     *string `json:"role"`
	NameEn   *string `json:"nameEn"`
	NameJa   *string `json:"nameJa"`
	NameCn   *string `json:"nameCn"`
	ImageUrl *string `json:"imageUrl"`
}

// staffList is a whole title's staff, and how many people that is -- a
// person credited twice is one person.  A row with no AniList id (written
// before 0037) is told apart by its names.
type staffList struct {
	credits []staffCredit
	people  int
}

func buildStaffList(rows []dbgen.ListAnimeStaffCreditsRow) *staffList {
	out := make([]staffCredit, 0, len(rows))
	people := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		out = append(out, staffCredit{
			StaffID:  r.StaffID,
			Role:     r.Role,
			NameEn:   r.NameEn,
			NameJa:   r.NameJa,
			NameCn:   r.NameCn,
			ImageUrl: r.ImageUrl,
		})
		people[staffIdentity(r)] = struct{}{}
	}
	return &staffList{credits: slices.Clip(out), people: len(people)}
}

// staffIdentity is who a credit names, as GetAnimeCreditCounts counts
// people: the AniList id, else the two names joined by chr(31).
func staffIdentity(r dbgen.ListAnimeStaffCreditsRow) string {
	if r.StaffID != nil {
		return "id:" + strconv.FormatInt(int64(*r.StaffID), 10)
	}
	return "name:" + derefStr(r.NameJa) + "\x1f" + derefStr(r.NameEn)
}
