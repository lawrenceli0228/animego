package bgmnames

import (
	"cmp"
	"maps"
	"slices"
)

// Title is one of our titles bound to a Bangumi subject
// (anime_cache.bgm_id).  The binding is not trusted; see the package doc.
type Title struct {
	AnilistID  int32
	BgmSubject int32
}

// Voice is one voice on one of our titles: AniList's character and the
// person voicing them, each with the native name AniList stores.
type Voice struct {
	AnimeID         int32
	CharacterID     int32
	CharacterNative string
	StaffID         int32
	StaffNative     string
}

// Credit is one staff credit on one of our titles.
type Credit struct {
	AnimeID     int32
	StaffID     int32
	StaffNative string
}

// Input is our side of the match, as the credit tables hold it.
type Input struct {
	Titles []Title
	Voices []Voice
	Staff  []Credit
}

// Pair is an accepted match: AniList id AnilistID is Bangumi id BgmID.
type Pair struct {
	AnilistID int32
	BgmID     int32
	// AniListName and BgmName are the two names that matched, for reports.
	AniListName string
	BgmName     string
	// NameCn is Bangumi's simplified Chinese name, "" when it states none:
	// the match is kept either way.
	NameCn string
	// Summary is a character's Bangumi summary (Entity.Summary); "" for a
	// person and for a character without one.
	Summary string
	// Titles are our titles the match was found in, ascending.
	Titles []int32
}

// Conflict is a set of candidate pairs that cannot all be true: one AniList
// id with several Bangumi ids, or one Bangumi id with several AniList ids.
// None of them is written.
type Conflict struct {
	Kind       string // "people" or "characters"
	AnilistIDs []int32
	BgmIDs     []int32
	Titles     []int32
}

// Stats is what a run found, for the dry run's report.
type Stats struct {
	// Titles is the bound titles read; TitlesNotInDump of them are bound
	// to a subject the dump lists no cast or staff for; TitlesMatched gave
	// at least one accepted pair.
	Titles, TitlesNotInDump, TitlesMatched int
	// People: distinct AniList Staff ids with a native name to compare,
	// those matched, those dropped in a conflict, and the matched ones
	// Bangumi gives a Chinese name.  ByVoice and ByStaff are how the
	// matched were found (one person can be found both ways).
	PeopleConsidered, PeopleMatched, PeopleConflicted, PeopleNamed int
	ByVoice, ByStaff                                               int
	// Characters: the same, for AniList Character ids that have a voice.
	CharactersConsidered, CharactersMatched, CharactersConflicted, CharactersNamed int
}

// Result is a whole run's matches.
type Result struct {
	People     []Pair
	Characters []Pair
	Conflicts  []Conflict
	Stats      Stats
}

// Match matches every bound title's cast and staff against its subject in
// the archive; see the package doc for the rules.
func Match(in Input, a *Archive) Result {
	var res Result
	res.Stats.Titles = len(in.Titles)

	voices := make(map[int32][]Voice)
	people, characters := map[int32]bool{}, map[int32]bool{}
	for _, v := range in.Voices {
		voices[v.AnimeID] = append(voices[v.AnimeID], v)
		if Normalize(v.StaffNative) != "" {
			people[v.StaffID] = true
		}
		if Normalize(v.CharacterNative) != "" {
			characters[v.CharacterID] = true
		}
	}
	staff := make(map[int32][]Credit)
	for _, c := range in.Staff {
		staff[c.AnimeID] = append(staff[c.AnimeID], c)
		if Normalize(c.StaffNative) != "" {
			people[c.StaffID] = true
		}
	}
	res.Stats.PeopleConsidered, res.Stats.CharactersConsidered = len(people), len(characters)

	personCandidates := candidates{}
	var leads []characterLead
	for _, t := range in.Titles {
		casts, credited := a.Casts[t.BgmSubject], a.Staff[t.BgmSubject]
		if len(casts) == 0 && len(credited) == 0 {
			res.Stats.TitlesNotInDump++
			continue
		}
		castByName := byName(castPersons(casts), a.Persons)
		for _, v := range voices[t.AnilistID] {
			found := castByName[Normalize(v.StaffNative)]
			for _, p := range found {
				personCandidates.add(v.StaffID, p, v.StaffNative, a.Persons[p].Name, t.AnilistID).byVoice = true
			}
			if len(found) == 1 {
				leads = append(leads, characterLead{title: t, voice: v, personID: found[0]})
			}
		}
		staffByName := byName(credited, a.Persons)
		for _, c := range staff[t.AnilistID] {
			for _, p := range staffByName[Normalize(c.StaffNative)] {
				personCandidates.add(c.StaffID, p, c.StaffNative, a.Persons[p].Name, t.AnilistID).byStaff = true
			}
		}
	}

	var personConflicts []Conflict
	res.People, personConflicts, res.Stats.PeopleConflicted = personCandidates.resolve("people", a.Persons)
	accepted := make(map[int32]int32, len(res.People))
	for _, p := range res.People {
		accepted[p.AnilistID] = p.BgmID
		c := personCandidates[p.AnilistID][p.BgmID]
		if c.byVoice {
			res.Stats.ByVoice++
		}
		if c.byStaff {
			res.Stats.ByStaff++
		}
	}

	characterCandidates := candidates{}
	voiced := voicedBy{}
	for _, l := range leads {
		if bgm, ok := accepted[l.voice.StaffID]; !ok || bgm != l.personID {
			continue
		}
		key := Normalize(l.voice.CharacterNative)
		if key == "" {
			continue
		}
		for _, k := range voiced.characters(a, l.title.BgmSubject, l.personID) {
			if Normalize(a.Characters[k].Name) == key {
				characterCandidates.add(l.voice.CharacterID, k, l.voice.CharacterNative, a.Characters[k].Name, l.title.AnilistID)
			}
		}
	}
	var characterConflicts []Conflict
	res.Characters, characterConflicts, res.Stats.CharactersConflicted = characterCandidates.resolve("characters", a.Characters)

	res.Conflicts = append(personConflicts, characterConflicts...)
	matchedTitles := map[int32]bool{}
	for _, list := range [][]Pair{res.People, res.Characters} {
		for _, p := range list {
			for _, t := range p.Titles {
				matchedTitles[t] = true
			}
		}
	}
	res.Stats.TitlesMatched = len(matchedTitles)
	res.Stats.PeopleMatched, res.Stats.PeopleNamed = len(res.People), named(res.People)
	res.Stats.CharactersMatched, res.Stats.CharactersNamed = len(res.Characters), named(res.Characters)
	return res
}

// characterLead is a voice whose actor matched exactly one person in a
// title's cast: the route its character is matched through, once that
// person match is accepted.
type characterLead struct {
	title    Title
	voice    Voice
	personID int32
}

// castPersons lists the persons of a subject's cast, once each.
func castPersons(casts []Cast) []int32 {
	ids := make([]int32, 0, len(casts))
	for _, c := range casts {
		ids = append(ids, c.PersonID)
	}
	return firstOfEach(ids)
}

// byName indexes persons by normalised name.  More than one person under
// one name (namesakes in one cast) is kept as such: Match turns it into a
// conflict rather than choosing.
func byName(ids []int32, persons map[int32]Entity) map[string][]int32 {
	out := make(map[string][]int32, len(ids))
	for _, id := range ids {
		if key := Normalize(persons[id].Name); key != "" {
			out[key] = append(out[key], id)
		}
	}
	return out
}

// voicedBy indexes, per subject, the characters each person voices there.
// Built per subject on first use.
type voicedBy map[int32]map[int32][]int32

func (v voicedBy) characters(a *Archive, subject, person int32) []int32 {
	idx, ok := v[subject]
	if !ok {
		idx = map[int32][]int32{}
		for _, c := range a.Casts[subject] {
			idx[c.PersonID] = append(idx[c.PersonID], c.CharacterID)
		}
		v[subject] = idx
	}
	return idx[person]
}

// candidate is one possible pair and what supports it.
type candidate struct {
	anilistName, bgmName string
	titles               map[int32]bool
	byVoice, byStaff     bool
}

// candidates is every possible pair: AniList id -> Bangumi id -> support.
type candidates map[int32]map[int32]*candidate

// add records that a title supports anilist = bgm, and returns the pair's
// record so the caller can note the route.
func (c candidates) add(anilist, bgm int32, anilistName, bgmName string, title int32) *candidate {
	if c[anilist] == nil {
		c[anilist] = map[int32]*candidate{}
	}
	cand := c[anilist][bgm]
	if cand == nil {
		cand = &candidate{anilistName: anilistName, bgmName: bgmName, titles: map[int32]bool{}}
		c[anilist][bgm] = cand
	}
	cand.titles[title] = true
	return cand
}

// resolve keeps the pairs whose AniList id has one Bangumi id and whose
// Bangumi id has one AniList id, and reports every other set as a conflict.
// It also returns how many AniList ids had candidates and lost them all.
func (c candidates) resolve(kind string, entities map[int32]Entity) ([]Pair, []Conflict, int) {
	byBgm := map[int32][]int32{}
	for anilist, bgms := range c {
		for bgm := range bgms {
			byBgm[bgm] = append(byBgm[bgm], anilist)
		}
	}

	var pairs []Pair
	var conflicts []Conflict
	rejected := 0
	for anilist, bgms := range c {
		if len(bgms) > 1 {
			rejected++
			titles := map[int32]bool{}
			for _, cand := range bgms {
				maps.Copy(titles, cand.titles)
			}
			conflicts = append(conflicts, Conflict{Kind: kind, AnilistIDs: []int32{anilist},
				BgmIDs: sortedKeys(bgms), Titles: sortedKeys(titles)})
			continue
		}
		for bgm, cand := range bgms {
			if len(byBgm[bgm]) > 1 {
				rejected++
				continue
			}
			pairs = append(pairs, Pair{AnilistID: anilist, BgmID: bgm, AniListName: cand.anilistName,
				BgmName: cand.bgmName, NameCn: entities[bgm].NameCn, Summary: entities[bgm].Summary,
				Titles: sortedKeys(cand.titles)})
		}
	}
	for bgm, anilists := range byBgm {
		if len(anilists) < 2 {
			continue
		}
		titles := map[int32]bool{}
		for _, anilist := range anilists {
			maps.Copy(titles, c[anilist][bgm].titles)
		}
		ids := slices.Clone(anilists)
		slices.Sort(ids)
		conflicts = append(conflicts, Conflict{Kind: kind, AnilistIDs: ids, BgmIDs: []int32{bgm}, Titles: sortedKeys(titles)})
	}

	slices.SortFunc(pairs, func(x, y Pair) int { return cmp.Compare(x.AnilistID, y.AnilistID) })
	slices.SortFunc(conflicts, func(x, y Conflict) int {
		return cmp.Or(cmp.Compare(x.AnilistIDs[0], y.AnilistIDs[0]), cmp.Compare(x.BgmIDs[0], y.BgmIDs[0]))
	})
	return pairs, conflicts, rejected
}

// sortedKeys returns a map's int32 keys in ascending order.
func sortedKeys[V any](m map[int32]V) []int32 {
	return slices.Sorted(maps.Keys(m))
}

// named counts the pairs that carry a Chinese name.
func named(pairs []Pair) int {
	n := 0
	for _, p := range pairs {
		if p.NameCn != "" {
			n++
		}
	}
	return n
}
