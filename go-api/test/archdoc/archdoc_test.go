// Package archdoc holds the test that keeps go-api/ARCHITECTURE.md honest.
//
// The code map is only useful while it is complete: a reader who looks up a
// package, a job kind or a SQL file and does not find it will assume the map
// is wrong about everything else too, and stop using it.  A doc that nobody
// is forced to update goes stale within a few PRs, so this test is the force.
// It fails when something that exists in the tree is missing from the doc,
// and when the doc names a file or directory that no longer exists.
//
// What it checks, and what it deliberately does not:
//
//   - Every directory under go-api (testdata aside) is named in the doc,
//     itself or through a path below it.  This is the check that catches a
//     new package.
//   - Every internal/db/queries/*.sql file has a row in the SQL table, and
//     that row's query count matches the file's "-- name:" lines.
//   - Every migration has a row in the migration table.
//   - Every job kind and every queue the production registry declares is
//     named.  Read from queue.Default() rather than from source text, so the
//     list is exactly what river is given.
//   - Every env switch internal/queue and internal/hant declare is named.
//   - Every /api/<segment> prefix a router registers is named.
//   - Every path the doc writes in backticks exists, and so does every bare
//     file name listed in a table row whose first cell is a directory (or in
//     the jobs section, where the directory is internal/queue).
//
// It does not check the uses / used-by columns or the prose.  Those change
// with ordinary refactors, and failing CI on an import edit would teach
// people to delete the columns rather than keep them.
package archdoc

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// moduleRoot is go-api/, relative to this package's directory, which is
// where go test runs it.
const moduleRoot = "../.."

// repoRoot is the repository root, for the few paths the doc names from
// there (go-api itself, .github/workflows, next-app, e2e, ws-server).
const repoRoot = "../../.."

// staleReferences are paths the doc names precisely because they do not
// exist: §13 records that README.md and the Makefile still point at them.
// Drop an entry when the reference it describes is cleaned up.
var staleReferences = map[string]bool{
	"cmd/migrate-mongo": true,
	"cmd/parity-check":  true,
}

func readDoc(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(moduleRoot, "ARCHITECTURE.md"))
	if err != nil {
		t.Fatalf("read ARCHITECTURE.md: %v", err)
	}
	return string(b)
}

// stripFences removes fenced code blocks.  Their contents are diagrams, and
// a stray backtick pair inside one would otherwise read as a path.
func stripFences(doc string) string {
	var out strings.Builder
	in := false
	for _, line := range strings.Split(doc, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			in = !in
			continue
		}
		if !in {
			out.WriteString(line)
			out.WriteByte('\n')
		}
	}
	return out.String()
}

var codeSpan = regexp.MustCompile("`([^`\n]+)`")

// spans returns every backticked token in s.
func spans(s string) []string {
	var out []string
	for _, m := range codeSpan.FindAllStringSubmatch(s, -1) {
		out = append(out, m[1])
	}
	return out
}

// mentioned reports whether the doc names path p in backticks, either p
// itself (with or without a trailing slash) or something below it.
func mentioned(tokens []string, p string) bool {
	for _, tok := range tokens {
		tok = strings.TrimSuffix(tok, "/")
		if tok == p || strings.HasPrefix(tok, p+"/") {
			return true
		}
	}
	return false
}

func TestEveryDirectoryIsMapped(t *testing.T) {
	tokens := spans(stripFences(readDoc(t)))
	err := filepath.WalkDir(moduleRoot, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(moduleRoot, path)
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") || name == "testdata" {
			return filepath.SkipDir
		}
		if !mentioned(tokens, rel) {
			t.Errorf("directory %s is not named in ARCHITECTURE.md", rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

var packageCount = regexp.MustCompile(`平铺的 (\d+) 个包`)

// TestPackageCount keeps the one count the doc states about internal/ true.
func TestPackageCount(t *testing.T) {
	m := packageCount.FindStringSubmatch(readDoc(t))
	if m == nil {
		t.Fatal("ARCHITECTURE.md no longer states how many packages internal/ holds")
	}
	want, _ := strconv.Atoi(m[1])
	got := 0
	err := filepath.WalkDir(filepath.Join(moduleRoot, "internal"), func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && d.Name() == "testdata" {
			return filepath.SkipDir
		}
		if !d.IsDir() {
			return nil
		}
		entries, err := os.ReadDir(path)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".go") && !strings.HasSuffix(e.Name(), "_test.go") {
				got++
				break
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("ARCHITECTURE.md says internal/ holds %d packages; it holds %d", want, got)
	}
}

var sqlRow = regexp.MustCompile("(?m)^\\| `([a-z_]+\\.sql)` \\| (\\d+) \\|")

func TestEverySQLFileHasARowWithItsQueryCount(t *testing.T) {
	rows := map[string]int{}
	for _, m := range sqlRow.FindAllStringSubmatch(readDoc(t), -1) {
		n, _ := strconv.Atoi(m[2])
		rows[m[1]] = n
	}
	files, err := filepath.Glob(filepath.Join(moduleRoot, "internal/db/queries/*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("found no SQL files; has internal/db/queries moved?")
	}
	for _, f := range files {
		name := filepath.Base(f)
		want, ok := rows[name]
		if !ok {
			t.Errorf("%s has no row in the SQL table", name)
			continue
		}
		if got := countQueries(t, f); got != want {
			t.Errorf("%s: the SQL table says %d queries, the file has %d", name, want, got)
		}
		delete(rows, name)
	}
	for name := range rows {
		t.Errorf("the SQL table lists %s, which does not exist", name)
	}
}

func countQueries(t *testing.T, path string) int {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "-- name:") {
			n++
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return n
}

var migrationFile = regexp.MustCompile(`^(\d{4})_(.+)\.up\.sql$`)

func TestEveryMigrationHasARow(t *testing.T) {
	doc := readDoc(t)
	entries, err := os.ReadDir(filepath.Join(moduleRoot, "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, e := range entries {
		m := migrationFile.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		seen++
		row := "| " + m[1] + " | `" + m[2] + "` |"
		if !strings.Contains(doc, row) {
			t.Errorf("migration %s_%s has no row %q in the migration table", m[1], m[2], row)
		}
	}
	if seen == 0 {
		t.Fatal("found no migrations; has migrations/ moved?")
	}
}

func TestEveryJobKindAndQueueIsNamed(t *testing.T) {
	tokens := spans(readDoc(t))
	has := func(s string) bool {
		for _, tok := range tokens {
			if tok == s {
				return true
			}
		}
		return false
	}
	reg := queue.Default()
	for _, kind := range reg.Kinds() {
		if !has(kind) {
			t.Errorf("job kind %s is not named in ARCHITECTURE.md", kind)
		}
	}
	for _, name := range reg.Names() {
		if !has(name) {
			t.Errorf("queue %s is not named in ARCHITECTURE.md", name)
		}
	}
}

// envConst matches the constants the sweeps and the hant loader name their
// switches with: `fooEnabledEnv = "FOO"`, `DataDirEnv = "HANT_DATA_DIR"`.
var envConst = regexp.MustCompile(`\w+Env\s*=\s*"([A-Z0-9_]+)"`)

func TestEveryEnvSwitchIsNamed(t *testing.T) {
	doc := readDoc(t)
	found := 0
	for _, dir := range []string{"internal/queue", "internal/hant"} {
		files, err := filepath.Glob(filepath.Join(moduleRoot, dir, "*.go"))
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			b, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			for _, m := range envConst.FindAllStringSubmatch(string(b), -1) {
				found++
				if !strings.Contains(doc, "`"+m[1]+"`") {
					t.Errorf("env switch %s (%s) is not named in ARCHITECTURE.md", m[1], filepath.Base(f))
				}
			}
		}
	}
	if found == 0 {
		t.Fatal("found no env switch constants; has the naming convention changed?")
	}
}

// apiPrefix matches the first segment of a route a chi router registers by
// literal: r.Get("/api/feed", ...), r.Route("/api/anime", ...).
var apiPrefix = regexp.MustCompile(`\.(?:Get|Post|Put|Patch|Delete|Route|Handle|HandleFunc)\("(/api/[a-z-]+)`)

func TestEveryAPIPrefixIsNamed(t *testing.T) {
	tokens := spans(readDoc(t))
	prefixes := map[string]string{}
	for _, dir := range []string{"cmd", "internal"} {
		err := filepath.WalkDir(filepath.Join(moduleRoot, dir), func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			b, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			for _, line := range strings.Split(string(b), "\n") {
				// Doc comments show usage examples ("r.Get(\"/api/me\", ...)")
				// that no router registers.
				if strings.HasPrefix(strings.TrimSpace(line), "//") {
					continue
				}
				for _, m := range apiPrefix.FindAllStringSubmatch(line, -1) {
					prefixes[m[1]] = path
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(prefixes) == 0 {
		t.Fatal("found no /api routes; has route registration moved?")
	}
	for p, file := range prefixes {
		found := false
		for _, tok := range tokens {
			if tok == p || strings.HasPrefix(tok, p+"/") {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("route prefix %s (registered in %s) is not named in ARCHITECTURE.md", p, file)
		}
	}
}

// TestEverySourceFileIsListed requires every non-test .go file to be listed,
// by bare name in its own package's row or by full path anywhere.  A bare
// name only counts in its own row: admin's users.go does not cover
// migrate/transforms/users.go.  internal/db/gen is exempt, being one
// generated file per SQL file plus sqlc's fixed set.
func TestEverySourceFileIsListed(t *testing.T) {
	doc := stripFences(readDoc(t))
	listed := map[string]bool{} // module-relative paths
	section := ""
	for _, line := range strings.Split(doc, "\n") {
		if strings.HasPrefix(line, "## ") {
			section = line
		}
		toks := spans(line)
		base := rowBase(line, toks, section)
		for _, tok := range toks {
			if strings.Contains(tok, "/") {
				listed[strings.TrimSuffix(tok, "/")] = true
			} else if base != "" {
				listed[base+"/"+tok] = true
			}
		}
	}
	for _, dir := range []string{"cmd", "internal"} {
		err := filepath.WalkDir(filepath.Join(moduleRoot, dir), func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(moduleRoot, path)
			rel = filepath.ToSlash(rel)
			if d.IsDir() {
				if rel == "internal/db/gen" || d.Name() == "testdata" {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(rel, ".go") || strings.HasSuffix(rel, "_test.go") {
				return nil
			}
			if !listed[rel] {
				t.Errorf("%s is not listed in ARCHITECTURE.md (name it in its package's row)", rel)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

// bareFile is a file name with no directory, as the "key files" columns
// write them.
var bareFile = regexp.MustCompile(`^[\w.-]+\.(go|json|sql|txt|md|yml|yaml)$`)

func TestEveryNamedPathExists(t *testing.T) {
	doc := stripFences(readDoc(t))
	section := ""
	for _, line := range strings.Split(doc, "\n") {
		if strings.HasPrefix(line, "## ") {
			section = line
		}
		toks := spans(line)
		base := rowBase(line, toks, section)
		for _, tok := range toks {
			if strings.ContainsAny(tok, " *<>") || strings.HasPrefix(tok, "/") || strings.HasPrefix(tok, "-") {
				continue
			}
			switch {
			case strings.Contains(tok, "/"):
				p := strings.TrimSuffix(tok, "/")
				if staleReferences[p] {
					continue
				}
				if strings.Contains(p, "://") {
					continue // a URL, not a path
				}
				// Paths are go-api-relative, except the ones the doc writes
				// from the repository root (go-api/, .github/, e2e/,
				// ws-server/).  No go-api directory shares a name with a
				// top-level one, so trying both cannot hide a missing path.
				_, errModule := os.Stat(filepath.Join(moduleRoot, p))
				_, errRepo := os.Stat(filepath.Join(repoRoot, p))
				if errModule != nil && errRepo != nil {
					t.Errorf("ARCHITECTURE.md names %s, which does not exist", tok)
				}
			case base != "" && bareFile.MatchString(tok):
				if _, err := os.Stat(filepath.Join(moduleRoot, base, tok)); err != nil {
					t.Errorf("ARCHITECTURE.md lists %s under %s, which does not have it", tok, base)
				}
			}
		}
	}
}

// rowBase is the directory a table row's bare file names live in: the row's
// first cell when that is a directory, internal/queue throughout the jobs
// section, and nothing otherwise.
func rowBase(line string, toks []string, section string) string {
	if !strings.HasPrefix(line, "| ") {
		return ""
	}
	if strings.HasPrefix(section, "## 6.") {
		return "internal/queue"
	}
	first := strings.SplitN(strings.TrimPrefix(line, "| "), " |", 2)[0]
	cell := spans(first)
	if len(cell) == 0 {
		return ""
	}
	p := strings.TrimSuffix(cell[0], "/")
	if fi, err := os.Stat(filepath.Join(moduleRoot, p)); err == nil && fi.IsDir() {
		return p
	}
	return ""
}
