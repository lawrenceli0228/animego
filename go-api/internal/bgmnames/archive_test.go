package bgmnames

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// writeDump writes a dump directory: each file name to its lines.  Files
// left out of files are written empty, so a test names only what it needs.
func writeDump(t *testing.T, files map[string][]string) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range DumpFiles {
		lines := files[name]
		body := strings.Join(lines, "\n")
		if len(lines) > 0 {
			body += "\n"
		}
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600))
	}
	return dir
}

// frierenDump is the shape of the real dump for subject 400602, cut down:
// three voices with their characters, one staff credit, the other two
// Bangumi persons named 田中敦子 (who are not in this cast), and a subject
// nobody asked about.
func frierenDump(t *testing.T) string {
	t.Helper()
	return writeDump(t, map[string][]string{
		"person.jsonlines": {
			`{"id":7575,"name":"種﨑敦美","type":1,"career":["seiyu"],"infobox":"{{Infobox Person\r\n|简体中文名= 种崎敦美\r\n|性别= 女\r\n}}","summary":"日本の声優。","comments":0,"collects":0}`,
			`{"id":31136,"name":"市ノ瀬加那","type":1,"career":["seiyu"],"infobox":"{{Infobox Person\r\n|简体中文名= 市之濑加那\r\n}}","summary":"","comments":0,"collects":0}`,
			`{"id":3873,"name":"田中敦子","type":1,"career":["seiyu"],"infobox":"{{Infobox Person\r\n|简体中文名= 田中敦子（声优）\r\n}}","summary":"","comments":0,"collects":0}`,
			`{"id":11679,"name":"田中敦子","type":1,"career":["producer"],"infobox":"{{Infobox Person\r\n|简体中文名= 田中敦子（动画人）\r\n}}","summary":"","comments":0,"collects":0}`,
			`{"id":40001,"name":"斎藤圭一郎","type":1,"career":["producer"],"infobox":"{{Infobox Person\r\n|简体中文名= 斋藤圭一郎\r\n}}","summary":"","comments":0,"collects":0}`,
			`{"id":99999,"name":"関係ない人","type":1,"career":[],"infobox":"","summary":"","comments":0,"collects":0}`,
		},
		"character.jsonlines": {
			`{"id":86246,"role":1,"name":"フリーレン","infobox":"{{Infobox Crt\r\n|简体中文名= 芙莉莲\r\n}}","summary":"","comments":0,"collects":0}`,
			`{"id":86247,"role":1,"name":"フェルン","infobox":"{{Infobox Crt\r\n|简体中文名= 菲伦\r\n}}","summary":"芙莉莲的弟子。\r\n[mask]后来成为一级魔法使。[/mask]","comments":0,"collects":0}`,
			`{"id":89180,"role":1,"name":"フランメ","infobox":"{{Infobox Crt\r\n|简体中文名= 伏拉梅\r\n}}","summary":"","comments":0,"collects":0}`,
			`{"id":12345,"role":1,"name":"誰か","infobox":"","summary":"","comments":0,"collects":0}`,
		},
		"subject-persons.jsonlines": {
			`{"person_id":40001,"subject_id":400602,"position":2,"appear_eps":""}`,
			`{"person_id":40001,"subject_id":400602,"position":74,"appear_eps":""}`,
			`{"person_id":11679,"subject_id":1,"position":2,"appear_eps":""}`,
		},
		"subject-characters.jsonlines": {
			`{"character_id":86246,"subject_id":400602,"type":1,"order":0}`,
		},
		"person-characters.jsonlines": {
			`{"person_id":7575,"subject_id":400602,"character_id":86246,"type":0,"summary":""}`,
			`{"person_id":31136,"subject_id":400602,"character_id":86247,"type":0,"summary":""}`,
			`{"person_id":3873,"subject_id":400602,"character_id":89180,"type":0,"summary":""}`,
			`{"person_id":99999,"subject_id":1,"character_id":12345,"type":0,"summary":""}`,
		},
	})
}

// TestLoadArchive_KeepsWhatTheSubjectsNeed — links are kept for the subjects
// asked about and nothing else, and persons and characters only when one of
// those links names them; Chinese names are read on the way in.
func TestLoadArchive_KeepsWhatTheSubjectsNeed(t *testing.T) {
	a, err := LoadArchive(frierenDump(t), map[int32]bool{400602: true})
	require.NoError(t, err)

	assert.Equal(t, []Cast{{7575, 86246}, {31136, 86247}, {3873, 89180}}, a.Casts[400602])
	assert.NotContains(t, a.Casts, int32(1))
	assert.Equal(t, []int32{40001}, a.Staff[400602], "one person, however many positions")
	assert.NotContains(t, a.Staff, int32(1))

	assert.Equal(t, Entity{Name: "種﨑敦美", NameCn: "种崎敦美"}, a.Persons[7575])
	assert.Equal(t, Entity{Name: "田中敦子", NameCn: "田中敦子"}, a.Persons[3873], "（声优） stripped")
	assert.Equal(t, Entity{Name: "斎藤圭一郎", NameCn: "斋藤圭一郎"}, a.Persons[40001])
	assert.NotContains(t, a.Persons, int32(11679), "a namesake outside the subjects is never loaded")
	assert.NotContains(t, a.Persons, int32(99999))
	assert.Len(t, a.Persons, 4)

	// A character's summary comes in cleaned (CleanSummary); a person's is
	// not read at all -- no page shows it, and the import holds every
	// matched person in memory.
	assert.Equal(t, Entity{Name: "フェルン", NameCn: "菲伦", Summary: "芙莉莲的弟子。\n~!后来成为一级魔法使。!~"}, a.Characters[86247])
	assert.Equal(t, Entity{Name: "フリーレン", NameCn: "芙莉莲"}, a.Characters[86246], "no summary is no summary")
	assert.NotContains(t, a.Characters, int32(12345))
	assert.Len(t, a.Characters, 3)
}

// TestLoadArchive_RefusesWhatItCannotRead — a dump that is missing a file,
// holds a line that is not JSON, or has lost a field the matcher keys on is
// an error with the file and line, never a smaller archive: the import
// replaces every stored match with what this run finds, so an archive read
// short would delete names that are right.
func TestLoadArchive_RefusesWhatItCannotRead(t *testing.T) {
	t.Run("missing file", func(t *testing.T) {
		dir := frierenDump(t)
		require.NoError(t, os.Remove(filepath.Join(dir, "person-characters.jsonlines")))
		_, err := LoadArchive(dir, map[int32]bool{400602: true})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "person-characters.jsonlines")
	})
	for name, tc := range map[string]struct{ file, line string }{
		"truncated line":     {"person-characters.jsonlines", `{"person_id":7575,"subject_id":400602,"charac`},
		"renamed key field":  {"subject-persons.jsonlines", `{"personId":40001,"subject_id":400602,"position":2}`},
		"person without id":  {"person.jsonlines", `{"name":"誰","infobox":""}`},
		"character, id zero": {"character.jsonlines", `{"id":0,"name":"誰","infobox":""}`},
	} {
		t.Run(name, func(t *testing.T) {
			dir := frierenDump(t)
			f, err := os.OpenFile(filepath.Join(dir, tc.file), os.O_APPEND|os.O_WRONLY, 0)
			require.NoError(t, err)
			_, err = f.WriteString(tc.line + "\n")
			require.NoError(t, err)
			require.NoError(t, f.Close())

			_, err = LoadArchive(dir, map[int32]bool{400602: true})
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.file)
			assert.Contains(t, err.Error(), "line ")
		})
	}
}

// TestLoadArchive_LongLines — a summary or infobox runs to tens of kilobytes
// in the real dump; a line longer than bufio's default must still be read.
func TestLoadArchive_LongLines(t *testing.T) {
	long := strings.Repeat("长", 200_000)
	dir := writeDump(t, map[string][]string{
		"person.jsonlines":            {`{"id":1,"name":"長い人","infobox":"{{Infobox\n|简体中文名= 长\n}}","summary":"` + long + `"}`},
		"person-characters.jsonlines": {`{"person_id":1,"subject_id":5,"character_id":2,"type":0,"summary":""}`},
		"character.jsonlines":         {`{"id":2,"name":"キャラ","infobox":"","summary":"` + long + `"}`},
	})
	a, err := LoadArchive(dir, map[int32]bool{5: true})
	require.NoError(t, err)
	assert.Equal(t, "长", a.Persons[1].NameCn)
	assert.Equal(t, "キャラ", a.Characters[2].Name)
}
