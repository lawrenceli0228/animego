package people

import (
	"cmp"
	"slices"
	"strconv"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// characterIndexable is the character page's indexing rule: a lead (MAIN)
// on at least one title, with a Chinese name from Bangumi.
//
// Characters outnumber people several times over, nearly all of them
// supporting roles on a single title, and AniList's description of them is
// English.  A lead with a Chinese name is a page a Chinese search can land
// on -- the name is the query -- and it has a voice cast and titles to show.
// Everything else is served and followed (noindex, follow).  The sitemap
// listing applies the same rule in SQL (ListCharactersSitemapShard).
func characterIndexable(name Name, appearances []Appearance) bool {
	if name.Cn == nil {
		return false
	}
	for _, a := range appearances {
		if roleRank(a.Role) == 0 {
			return true
		}
	}
	return false
}

// buildCharacter assembles GET /api/characters/:id.  ok is false when no
// non-adult title lists the character.  The name ladder is buildPerson's:
// the profile, else the most popular title's credit, and Bangumi alone for
// the Chinese name.
func buildCharacter(id int32, ident dbgen.GetCharacterIdentityRow, appearances []dbgen.ListCharacterAppearancesRow, voices []dbgen.ListCharacterVoicesRow) (*Character, bool) {
	if len(appearances) == 0 {
		return nil, false
	}

	apps := make([]Appearance, 0, len(appearances))
	for _, a := range appearances {
		apps = append(apps, Appearance{
			Anime: newWork(workColumns{
				id:            a.AnimeID,
				titleRomaji:   a.TitleRomaji,
				titleEnglish:  a.TitleEnglish,
				titleNative:   a.TitleNative,
				titleChinese:  a.TitleChinese,
				titleHant:     a.TitleHant,
				titleHantSeo:  a.TitleHantSeo,
				coverImageURL: a.CoverImageUrl,
				format:        a.Format,
				seasonYear:    a.SeasonYear,
				startDate:     a.StartDate,
				popularity:    a.Popularity,
				posterAccent:  a.PosterAccent,
			}),
			Role: text(a.Role),
		})
	}

	// The credit names and image, from the most popular title first.
	byPopularity := slices.Clone(appearances)
	slices.SortStableFunc(byPopularity, func(a, b dbgen.ListCharacterAppearancesRow) int {
		if c := comparePopularity(a.Popularity, b.Popularity); c != 0 {
			return c
		}
		return cmp.Compare(a.AnimeID, b.AnimeID)
	})
	var creditFull, creditNative, creditImage *string
	for _, a := range byPopularity {
		creditFull = firstText(creditFull, a.NameEn)
		creditNative = firstText(creditNative, a.NameJa)
		creditImage = firstText(creditImage, a.ImageUrl)
	}

	slices.SortStableFunc(apps, func(a, b Appearance) int { return compareWorksEarliestFirst(a.Anime, b.Anime) })

	name := Name{
		Full:   firstText(ident.NameFull, creditFull),
		Native: firstText(ident.NameNative, creditNative),
		Cn:     text(ident.NameCn),
	}
	c := &Character{
		AnilistID:        id,
		BangumiID:        ident.BgmID,
		Name:             name,
		AlternativeNames: alternativeNames(ident.NameAlternative, name),
		Image:            firstText(ident.ImageLarge, largeImage(creditImage)),
		Voices:           characterVoices(voices),
		Appearances:      apps,
		Indexable:        characterIndexable(name, apps),
	}
	if ident.HasProfile {
		c.Profile = &CharacterProfile{
			Description: text(ident.Description),
			Gender:      text(ident.Gender),
			Age:         text(ident.Age),
			Birth:       fuzzyDate(ident.BirthYear, ident.BirthMonth, ident.BirthDay),
			BloodType:   text(ident.BloodType),
			SiteURL:     text(ident.SiteUrl),
		}
	}
	return c, true
}

// characterVoices lists every person who voices the character, once per
// (person, language, note): the lead voice who carries the character across
// three seasons is one entry, and the same person credited for the child
// version is a second.
//
// Order: the languages in the order the most popular title lists them --
// which is the original language first, since a title's cast is written
// with its original-language voice at display_order 0 -- and within a
// language the main voice before the noted ones (童年 and the like), then
// as the titles list them.  Never nil.
func characterVoices(rows []dbgen.ListCharacterVoicesRow) []CharacterVoice {
	ordered := slices.Clone(rows)
	slices.SortStableFunc(ordered, func(a, b dbgen.ListCharacterVoicesRow) int {
		if c := comparePopularity(a.Popularity, b.Popularity); c != 0 {
			return c
		}
		if c := cmp.Compare(a.AnimeID, b.AnimeID); c != 0 {
			return c
		}
		return cmp.Compare(a.DisplayOrder, b.DisplayOrder)
	})

	type entry struct {
		voice     CharacterVoice
		langRank  int
		firstSeen int
	}
	langRank := map[string]int{}
	key := func(r dbgen.ListCharacterVoicesRow) string {
		k := ""
		if l := text(r.Language); l != nil {
			k = *l
		}
		k += "\x00"
		if n := text(r.RoleNotes); n != nil {
			k += *n
		}
		return k + "\x00" + strconv.FormatInt(int64(r.StaffID), 10)
	}
	seen := map[string]bool{}
	entries := []entry{}
	for i, r := range ordered {
		lang := ""
		if l := text(r.Language); l != nil {
			lang = *l
		}
		if _, ok := langRank[lang]; !ok {
			langRank[lang] = len(langRank)
		}
		k := key(r)
		if seen[k] {
			continue
		}
		seen[k] = true
		entries = append(entries, entry{
			voice: CharacterVoice{
				Person: PersonRef{
					AnilistID: r.StaffID,
					Name: Name{
						Full:   text(r.NameFull),
						Native: text(r.NameNative),
						Cn:     text(r.NameCn),
					},
					Image: firstText(r.ImageLarge, largeImage(r.ImageUrl)),
				},
				Language:  text(r.Language),
				RoleNotes: text(r.RoleNotes),
			},
			langRank:  langRank[lang],
			firstSeen: i,
		})
	}

	slices.SortStableFunc(entries, func(a, b entry) int {
		if c := cmp.Compare(a.langRank, b.langRank); c != 0 {
			return c
		}
		aNoted, bNoted := a.voice.RoleNotes != nil, b.voice.RoleNotes != nil
		if aNoted != bNoted {
			if aNoted {
				return 1
			}
			return -1
		}
		return cmp.Compare(a.firstSeen, b.firstSeen)
	})
	out := make([]CharacterVoice, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.voice)
	}
	return out
}
