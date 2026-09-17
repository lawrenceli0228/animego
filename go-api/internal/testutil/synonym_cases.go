package testutil

// SynonymScriptCases is the one table both spellings of the synonym script
// allowlist are held to: anilist.KeepSynonym (Go, at write time) and
// migration 0040 (PostgreSQL ARE, on the stored rows).  anilist's unit test
// runs the Go side; anime's synonym_scripts_pg_test.go runs the SQL side
// against a real database.  A range edited on one side and not the other
// fails one of them.
var SynonymScriptCases = []struct {
	Synonym string
	Keep    bool
}{
	{"海贼王", true},
	{"葬送のフリーレン", true},
	{"ワンピース", true},
	{"Sōsō no Furīren", true},                   // romaji with macrons: Latin Extended-A
	{"Pokémon", true},                           // Latin-1 accent
	{"Frieren – Nach dem Ende der Reise", true}, // en dash, U+2013
	{"Re:ZERO ～ 第4季", true},                     // fullwidth tilde
	{"ＯＰ", true},                                // fullwidth Latin
	{"魔法少女まどか☆マギカ", true},                       // ☆ U+2606
	{"Ван-Пис", false},                          // Cyrillic
	{"וואן פיס", false},                         // Hebrew
	{"ون بيس", false},                           // Arabic
	{"วันพีซ", false},                           // Thai
	{"Ντρέηκ", false},                           // Greek
	{"장송의 프리렌", false},                          // Hangul
	{"Vua Hải Tặc", false},                      // Vietnamese: U+1EA3, U+1EB7 (Latin Extended Additional)
	{"Frieren - Pháp sư tiễn táng", false},
	{"Ντρέηκ, το Κυνήγι", false},
}
