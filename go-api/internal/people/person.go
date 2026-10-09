package people

import (
	"cmp"
	"slices"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/overlay"
)

// The indexing threshold: a person page asks to be indexed once the person
// is credited on at least MinIndexedVoiceWorks non-adult titles as a voice,
// or MinIndexedStaffWorks as staff.  Below it the page is still served, and
// still followed (noindex, follow): every credit on it is a link to a title
// page, which is where the link weight should go.
//
// Why these numbers: a page lists its titles, and with one or two of them it
// says little that the title pages it links to do not already say.  Every
// person the site credits has a page, and most of them are credited once or
// twice, so indexing all of them would spend the crawl on near-duplicates of
// the title pages and dilute the sitemap the titles are in.  Three titles is where a
// voice actor's page becomes a filmography, the thing a search for their
// name is after.  Staff credits need more because one title usually credits
// a person several times (storyboard, episode direction, key animation) and
// a credit line carries less than a voiced character with its portrait.
//
// The threshold is the one knob to turn once Search Console shows how the
// indexed pages do; the sitemap listing reads the same two constants
// (ListPeopleSitemapShard), so the two cannot drift apart.
const (
	MinIndexedVoiceWorks = 3
	MinIndexedStaffWorks = 5
)

// RepresentativeRoleCount is how many roles the page leads with.
const RepresentativeRoleCount = 3

// personIndexable applies the threshold.
func personIndexable(voiceWorks, staffWorks int) bool {
	return voiceWorks >= MinIndexedVoiceWorks || staffWorks >= MinIndexedStaffWorks
}

// buildPerson assembles GET /api/people/:id from the three reads.  ok is
// false when no non-adult credit names the id: whatever profile or match the
// database holds, there is no page.
//
// The name ladder, field by field (the page picks among the three names per
// language; this decides where each one comes from):
//
//   - full and native: the AniList profile, else the credit of the most
//     popular title that stored one (a credit stores the person's name as
//     the title lists them);
//   - cn: Bangumi's match, and nothing else -- there is no other source of
//     a Chinese name, and a guess at one is worse than the native name;
//   - image: the profile's large portrait, else the credit's at the large
//     size (largeImage).
//
// The accepted edits in ov sit on top of every rung: the person's own
// (names, portrait, occupations and facts) and, on each voice role, the
// character's (its names, portrait and its role on that title).  They never
// change which titles are listed or counted, so the indexing threshold
// reads the credits alone, as the sitemap listing does.
func buildPerson(id int32, ident dbgen.GetPersonIdentityRow, voices []dbgen.ListPersonVoiceRolesRow, staff []dbgen.ListPersonStaffCreditsRow, ov pageOverlays) (*Person, bool) {
	if len(voices) == 0 && len(staff) == 0 {
		return nil, false
	}

	roles := make([]VoiceRole, 0, len(voices))
	for _, r := range voices {
		roles = append(roles, voiceRoleWith(voiceRoleFromRow(r), ov.characters[r.CharacterID]))
	}
	staffYears, staffWorks := groupStaffCredits(staff)

	creditFull, creditNative, creditImage := personCreditIdentity(voices, staff)
	name := nameWith(Name{
		Full:   firstText(ident.NameFull, creditFull),
		Native: firstText(ident.NameNative, creditNative),
		Cn:     text(ident.NameCn),
	}, ov.self)

	var profile *PersonProfile
	if ident.HasProfile {
		profile = &PersonProfile{
			Occupations: nonNil(ident.PrimaryOccupations),
			Gender:      text(ident.Gender),
			Birth:       fuzzyDate(ident.BirthYear, ident.BirthMonth, ident.BirthDay),
			Death:       fuzzyDate(ident.DeathYear, ident.DeathMonth, ident.DeathDay),
			Age:         ident.Age,
			YearsActive: nonNil(ident.YearsActive),
			HomeTown:    text(ident.HomeTown),
			BloodType:   text(ident.BloodType),
			Language:    text(ident.Language),
			SiteURL:     text(ident.SiteUrl),
		}
	}
	voiceWorks := distinctWorks(roles)
	return &Person{
		AnilistID:           id,
		BangumiID:           ident.BgmID,
		Name:                name,
		Image:               imageWith(firstText(ident.ImageLarge, largeImage(creditImage)), ov.self),
		Profile:             personProfileWith(profile, ov.self),
		RepresentativeRoles: representativeRoles(roles, RepresentativeRoleCount),
		VoiceRoles:          groupVoiceRoles(roles),
		StaffRoles:          staffYears,
		VoiceWorkCount:      voiceWorks,
		StaffWorkCount:      staffWorks,
		Indexable:           personIndexable(voiceWorks, staffWorks),
	}, true
}

// voiceRoleWith is a voice role with the character's accepted edits on it:
// its names and portrait, and its role on the role's title.
func voiceRoleWith(r VoiceRole, o overlay.Doc) VoiceRole {
	next := r
	next.Character = characterRefWith(r.Character, o)
	next.Role = roleWith(r.Role, o, r.Anime.AnilistID)
	return next
}

// personCreditIdentity is the person's name and image as their credits
// stored them, each field from the most popular title that has it.
func personCreditIdentity(voices []dbgen.ListPersonVoiceRolesRow, staff []dbgen.ListPersonStaffCreditsRow) (full, native, image *string) {
	type credit struct {
		full, native, image *string
		popularity          *int32
		animeID             int32
	}
	credits := make([]credit, 0, len(voices)+len(staff))
	for _, v := range voices {
		credits = append(credits, credit{v.PersonFull, v.PersonNative, v.PersonImage, v.Popularity, v.AnimeID})
	}
	for _, s := range staff {
		credits = append(credits, credit{s.PersonFull, s.PersonNative, s.PersonImage, s.Popularity, s.AnimeID})
	}
	slices.SortStableFunc(credits, func(a, b credit) int {
		if c := comparePopularity(a.popularity, b.popularity); c != 0 {
			return c
		}
		return cmp.Compare(a.animeID, b.animeID)
	})
	for _, c := range credits {
		if full == nil {
			full = text(c.full)
		}
		if native == nil {
			native = text(c.native)
		}
		if image == nil {
			image = text(c.image)
		}
	}
	return full, native, image
}

// voiceRoleFromRow is one ListPersonVoiceRoles row as the page shows it.
// The character's large image is the profile's when the sweep has one, else
// the credit's at the large size.
func voiceRoleFromRow(r dbgen.ListPersonVoiceRolesRow) VoiceRole {
	return VoiceRole{
		Character: CharacterRef{
			AnilistID: r.CharacterID,
			Name: Name{
				Full:   text(r.CharacterFull),
				Native: text(r.CharacterNative),
				Cn:     text(r.CharacterCn),
			},
			Image: firstText(r.CharacterImageLarge, largeImage(r.CharacterImage)),
		},
		Anime: newWork(workColumns{
			id:            r.AnimeID,
			titleRomaji:   r.TitleRomaji,
			titleEnglish:  r.TitleEnglish,
			titleNative:   r.TitleNative,
			titleChinese:  r.TitleChinese,
			titleHant:     r.TitleHant,
			titleHantSeo:  r.TitleHantSeo,
			coverImageURL: r.CoverImageUrl,
			format:        r.Format,
			seasonYear:    r.SeasonYear,
			startDate:     r.StartDate,
			popularity:    r.Popularity,
			posterAccent:  r.PosterAccent,
		}),
		Role:           text(r.Role),
		Language:       text(r.Language),
		RoleNotes:      text(r.RoleNotes),
		characterOrder: r.CharacterOrder,
	}
}

// compareVoiceRolesNewestFirst is the timeline order: by title (see
// compareWorksNewestFirst), then by the character's place in that title's
// cast.
func compareVoiceRolesNewestFirst(a, b VoiceRole) int {
	if c := compareWorksNewestFirst(a.Anime, b.Anime); c != 0 {
		return c
	}
	if c := cmp.Compare(a.characterOrder, b.characterOrder); c != 0 {
		return c
	}
	return cmp.Compare(a.Character.AnilistID, b.Character.AnilistID)
}

// groupVoiceRoles is the voice timeline: newest first, one group per year.
// Never nil.
func groupVoiceRoles(roles []VoiceRole) []VoiceYear {
	sorted := slices.Clone(roles)
	slices.SortStableFunc(sorted, compareVoiceRolesNewestFirst)
	years := []VoiceYear{}
	for _, r := range sorted {
		if n := len(years); n > 0 && sameYear(years[n-1].Year, r.Anime.Year) {
			years[n-1].Roles = append(years[n-1].Roles, r)
			continue
		}
		years = append(years, VoiceYear{Year: r.Anime.Year, Roles: []VoiceRole{r}})
	}
	return years
}

// groupStaffCredits merges a person's credits into one entry per title, the
// roles in the order the title lists them, and groups the titles by year,
// newest first.  It returns the groups (never nil) and the number of
// titles.
func groupStaffCredits(credits []dbgen.ListPersonStaffCreditsRow) ([]StaffYear, int) {
	works := []StaffWork{}
	index := map[int32]int{}
	// The query returns credits ordered by title and then by the title's
	// staff order, so appending keeps each title's roles in credit order.
	for _, c := range credits {
		role := text(c.Role)
		if i, ok := index[c.AnimeID]; ok {
			if role != nil {
				works[i].Roles = append(works[i].Roles, *role)
			}
			continue
		}
		w := StaffWork{
			Anime: newWork(workColumns{
				id:            c.AnimeID,
				titleRomaji:   c.TitleRomaji,
				titleEnglish:  c.TitleEnglish,
				titleNative:   c.TitleNative,
				titleChinese:  c.TitleChinese,
				titleHant:     c.TitleHant,
				titleHantSeo:  c.TitleHantSeo,
				coverImageURL: c.CoverImageUrl,
				format:        c.Format,
				seasonYear:    c.SeasonYear,
				startDate:     c.StartDate,
				popularity:    c.Popularity,
				posterAccent:  c.PosterAccent,
			}),
			Roles: []string{},
		}
		if role != nil {
			w.Roles = append(w.Roles, *role)
		}
		index[c.AnimeID] = len(works)
		works = append(works, w)
	}

	slices.SortStableFunc(works, func(a, b StaffWork) int { return compareWorksNewestFirst(a.Anime, b.Anime) })
	years := []StaffYear{}
	for _, w := range works {
		if n := len(years); n > 0 && sameYear(years[n-1].Year, w.Anime.Year) {
			years[n-1].Works = append(years[n-1].Works, w)
			continue
		}
		years = append(years, StaffYear{Year: w.Anime.Year, Works: []StaffWork{w}})
	}
	return years, len(works)
}

// roleRank orders a character's role on a title: lead, supporting,
// background, then anything AniList adds later.
func roleRank(role *string) int {
	if role == nil {
		return 3
	}
	switch *role {
	case "MAIN":
		return 0
	case "SUPPORTING":
		return 1
	case "BACKGROUND":
		return 2
	default:
		return 3
	}
}

// representativeRoles picks the roles the person page leads with: lead roles
// before supporting ones, and within a rank the most popular titles first,
// so a reader arriving from search sees the role they know rather than
// whatever aired last.  Each character appears once, in its most popular
// title (a lead across three seasons is one role), and each title once (two
// cards from one show say less than one card each from two).  At most n.
func representativeRoles(roles []VoiceRole, n int) []VoiceRole {
	ranked := slices.Clone(roles)
	slices.SortStableFunc(ranked, func(a, b VoiceRole) int {
		if c := cmp.Compare(roleRank(a.Role), roleRank(b.Role)); c != 0 {
			return c
		}
		if c := comparePopularity(a.Anime.Popularity, b.Anime.Popularity); c != 0 {
			return c
		}
		if c := cmp.Compare(a.Anime.AnilistID, b.Anime.AnilistID); c != 0 {
			return c
		}
		if c := cmp.Compare(a.characterOrder, b.characterOrder); c != 0 {
			return c
		}
		return cmp.Compare(a.Character.AnilistID, b.Character.AnilistID)
	})
	out := []VoiceRole{}
	characters := map[int32]bool{}
	titles := map[int32]bool{}
	for _, r := range ranked {
		if len(out) == n {
			break
		}
		if characters[r.Character.AnilistID] || titles[r.Anime.AnilistID] {
			continue
		}
		characters[r.Character.AnilistID] = true
		titles[r.Anime.AnilistID] = true
		out = append(out, r)
	}
	return out
}

// distinctWorks counts the titles among roles.
func distinctWorks(roles []VoiceRole) int {
	seen := map[int32]bool{}
	for _, r := range roles {
		seen[r.Anime.AnilistID] = true
	}
	return len(seen)
}

// nonNil returns s, or an empty slice for nil, so the JSON says [] rather
// than null.
func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
