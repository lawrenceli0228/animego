package bgmnames

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// The dump files LoadArchive reads.  The weekly zip holds more
// (subject.jsonlines alone is close to a gigabyte); only these four are
// needed, and only they have to be extracted.
const (
	personFile          = "person.jsonlines"
	characterFile       = "character.jsonlines"
	subjectPersonsFile  = "subject-persons.jsonlines"
	personCharacterFile = "person-characters.jsonlines"
)

// DumpFiles lists the files LoadArchive reads from a dump directory.
var DumpFiles = []string{personFile, characterFile, subjectPersonsFile, personCharacterFile}

// maxLine bounds one line of a dump file.  A record's summary and infobox
// run to tens of kilobytes; bufio's default 64 KiB would refuse the
// longest of them.
const maxLine = 64 << 20

// Entity is a Bangumi person or character as the matcher sees it: the name
// it is compared by and the Chinese name it gives (ChineseName; "" when
// Bangumi states none).
type Entity struct {
	Name   string
	NameCn string
	// Summary is a character's Bangumi summary in the character page's
	// markup (CleanSummary), "" when it has none.  A person's is not read:
	// no page shows it, and every matched person is held in memory.
	Summary string
}

// Cast is one person-characters link inside a subject: PersonID voices
// CharacterID there.
type Cast struct {
	PersonID    int32
	CharacterID int32
}

// Archive is the part of a dump the matcher needs, restricted to the
// subjects it was loaded for.
type Archive struct {
	// Persons and Characters hold only the ids some kept link names.
	Persons    map[int32]Entity
	Characters map[int32]Entity
	// Casts is each subject's voice links, in dump order.
	Casts map[int32][]Cast
	// Staff is each subject's credited persons, once each whatever the
	// number of positions, in dump order.
	Staff map[int32][]int32
}

// LoadArchive reads a dump directory for the given subjects: their cast
// and staff links, then the persons and characters those links name.
//
// It refuses rather than reads short.  A missing file, a line that is not
// JSON, or a line without the ids the matcher keys on -- a truncated
// download, or a field Bangumi renamed -- is an error naming the file and
// line, because the import replaces every stored match with what this run
// finds, and an archive read short would delete names that are right.
func LoadArchive(dir string, subjects map[int32]bool) (*Archive, error) {
	a := &Archive{
		Persons:    map[int32]Entity{},
		Characters: map[int32]Entity{},
		Casts:      map[int32][]Cast{},
		Staff:      map[int32][]int32{},
	}
	wantPersons := map[int32]bool{}
	wantCharacters := map[int32]bool{}

	err := eachLine(dir, personCharacterFile, func(line []byte) error {
		var r struct {
			PersonID    int32 `json:"person_id"`
			SubjectID   int32 `json:"subject_id"`
			CharacterID int32 `json:"character_id"`
		}
		if err := json.Unmarshal(line, &r); err != nil {
			return err
		}
		if r.PersonID <= 0 || r.SubjectID <= 0 || r.CharacterID <= 0 {
			return errMissingIDs
		}
		if subjects[r.SubjectID] {
			a.Casts[r.SubjectID] = append(a.Casts[r.SubjectID], Cast{PersonID: r.PersonID, CharacterID: r.CharacterID})
			wantPersons[r.PersonID], wantCharacters[r.CharacterID] = true, true
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	err = eachLine(dir, subjectPersonsFile, func(line []byte) error {
		var r struct {
			PersonID  int32 `json:"person_id"`
			SubjectID int32 `json:"subject_id"`
		}
		if err := json.Unmarshal(line, &r); err != nil {
			return err
		}
		if r.PersonID <= 0 || r.SubjectID <= 0 {
			return errMissingIDs
		}
		if subjects[r.SubjectID] {
			a.Staff[r.SubjectID] = append(a.Staff[r.SubjectID], r.PersonID)
			wantPersons[r.PersonID] = true
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for subject, persons := range a.Staff {
		a.Staff[subject] = firstOfEach(persons)
	}

	if err := loadEntities(dir, personFile, wantPersons, a.Persons, false); err != nil {
		return nil, err
	}
	if err := loadEntities(dir, characterFile, wantCharacters, a.Characters, true); err != nil {
		return nil, err
	}
	return a, nil
}

// firstOfEach drops repeats from ids, keeping the first of each in order.
// A person holds several positions on one subject (director and
// storyboard), one subject-persons line each.
func firstOfEach(ids []int32) []int32 {
	seen := make(map[int32]bool, len(ids))
	out := make([]int32, 0, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// errMissingIDs is a dump line without the ids the matcher keys on.
var errMissingIDs = fmt.Errorf("a key id is missing or not positive")

// loadEntities reads person.jsonlines or character.jsonlines into dest,
// keeping the ids in want.  Every line is checked for an id, kept or not:
// a renamed field shows on the first line, not only on the ones asked for.
func loadEntities(dir, file string, want map[int32]bool, dest map[int32]Entity, withSummary bool) error {
	return eachLine(dir, file, func(line []byte) error {
		var r struct {
			ID      int32  `json:"id"`
			Name    string `json:"name"`
			Infobox string `json:"infobox"`
			// Not in the dump's person or character records today (only
			// subjects and episodes carry one); read in case a later dump
			// adds it, as ChineseName's fallback.
			NameCn  string `json:"name_cn"`
			Summary string `json:"summary"`
		}
		if err := json.Unmarshal(line, &r); err != nil {
			return err
		}
		if r.ID <= 0 {
			return errMissingIDs
		}
		if want[r.ID] {
			e := Entity{Name: r.Name, NameCn: ChineseName(r.Infobox, r.NameCn)}
			if withSummary {
				e.Summary = CleanSummary(r.Summary)
			}
			dest[r.ID] = e
		}
		return nil
	})
}

// eachLine calls fn for every non-blank line of dir/file, stopping at the
// first error, which it returns with the file and line number.
func eachLine(dir, file string, fn func([]byte) error) error {
	f, err := os.Open(filepath.Join(dir, file))
	if err != nil {
		return fmt.Errorf("open dump file: %w", err)
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), maxLine)
	for n := 1; sc.Scan(); n++ {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		if err := fn(line); err != nil {
			return fmt.Errorf("%s line %d: %w", file, n, err)
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("read %s: %w", file, err)
	}
	return nil
}
