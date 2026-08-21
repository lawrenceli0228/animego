package main

// The report half of the tool: fetch, classify, print, write.
//
// The ladder itself is covered in internal/hant.  What is pinned here is
// the sequence — that the file lands, that it lands before --apply is
// reached, and that the rows handed to --apply are the ones the operator
// was shown.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/hant"
)

// fakeLister stands in for *dbgen.Queries' whole-table read.
type fakeLister struct {
	rows []dbgen.ListAnimeForHantBackfillRow
	err  error
}

func (f fakeLister) ListAnimeForHantBackfill(context.Context) ([]dbgen.ListAnimeForHantBackfillRow, error) {
	return f.rows, f.err
}

// cliDataDir resolves go-api/data/hant from this source file's location,
// so the test does not care what directory `go test` was invoked from.
func cliDataDir(t *testing.T) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// cmd/hantbackfill/report_test.go -> cmd/hantbackfill -> cmd -> go-api
	return filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(self))), "data", "hant")
}

func testResolver(t *testing.T) *hant.Resolver {
	t.Helper()
	res, err := hant.NewResolverFromDir(cliDataDir(t))
	if err != nil {
		t.Fatalf("NewResolverFromDir: %v", err)
	}
	return res
}

// A report an operator can read is the whole point of a run that does not
// write, and the record of a run that does.  It has to reach the named
// path, parse, and describe the rows that were actually classified.
func TestRunReportWritesTheFileAndReturnsTheClassification(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, defaultReportFile)

	rows := []dbgen.ListAnimeForHantBackfillRow{
		{AnilistID: 16498, TitleChinese: ptr("进击的巨人"), DescriptionCn: ptr("简介。")},
		{AnilistID: 99000001},
	}

	var out bytes.Buffer
	results, err := runReport(context.Background(), &out, testResolver(t), fakeLister{rows: rows}, 0, false, path)
	if err != nil {
		t.Fatalf("runReport: %v", err)
	}

	if len(results) != len(rows) {
		t.Fatalf("classified %d rows, want %d — --apply writes exactly what this returns", len(results), len(rows))
	}
	if !strings.Contains(out.String(), "Rows scanned: 2") {
		t.Errorf("summary does not say what it scanned:\n%s", out.String())
	}

	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the report did not reach %s: %v", path, err)
	}
	var rep hant.Report
	if err := json.Unmarshal(blob, &rep); err != nil {
		t.Fatalf("the report is not readable JSON: %v", err)
	}
	if rep.TotalRows != len(rows) {
		t.Errorf("report says %d rows, want %d", rep.TotalRows, len(rows))
	}
	if rep.RestaleOnly {
		t.Error("RestaleOnly is set on a run that did not pass --restale")
	}
}

// --restale has to reach the file as well as the screen.  The flag
// changes which rows --apply is willing to write, so a report that does
// not record it cannot be matched to what the run did.
func TestRunReportRecordsRestale(t *testing.T) {
	path := filepath.Join(t.TempDir(), defaultReportFile)

	var out bytes.Buffer
	_, err := runReport(context.Background(), &out, testResolver(t),
		fakeLister{rows: []dbgen.ListAnimeForHantBackfillRow{{AnilistID: 1}}}, 0, true, path)
	if err != nil {
		t.Fatalf("runReport: %v", err)
	}

	if !strings.Contains(out.String(), "--restale") {
		t.Errorf("summary does not say which mode produced it:\n%s", out.String())
	}
	blob, _ := os.ReadFile(path)
	var rep hant.Report
	if err := json.Unmarshal(blob, &rep); err != nil {
		t.Fatal(err)
	}
	if !rep.RestaleOnly {
		t.Error("restale_only did not reach the file")
	}
}

// --limit caps the classification, and the cap has to be applied to the
// rows rather than merely printed: a report that says 2 rows while
// --apply holds 500 would send an operator into a write they did not
// review.
func TestRunReportHonoursTheLimit(t *testing.T) {
	rows := make([]dbgen.ListAnimeForHantBackfillRow, 5)
	for i := range rows {
		rows[i] = dbgen.ListAnimeForHantBackfillRow{AnilistID: int32(i + 1), TitleChinese: ptr("鬼灭之刃")}
	}
	path := filepath.Join(t.TempDir(), "hant-report-limit-2.json")

	results, err := runReport(context.Background(), new(bytes.Buffer), testResolver(t), fakeLister{rows: rows}, 2, false, path)
	if err != nil {
		t.Fatalf("runReport: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("classified %d rows under --limit 2", len(results))
	}
}

// Both failure modes have to come back as errors rather than as a report
// that quietly describes nothing: main() treats a nil return as "the
// operator has seen the plan" and proceeds to --apply.
func TestRunReportFailures(t *testing.T) {
	boom := errors.New("connection reset by peer")

	cases := []struct {
		name   string
		lister fakeLister
		path   string
		wantIn string
	}{
		{
			name:   "the whole-table read failed",
			lister: fakeLister{err: boom},
			path:   filepath.Join(t.TempDir(), defaultReportFile),
			wantIn: "connection reset by peer",
		},
		{
			name:   "the report could not be written",
			lister: fakeLister{rows: []dbgen.ListAnimeForHantBackfillRow{{AnilistID: 1}}},
			// A directory: os.Create cannot truncate one.
			path:   t.TempDir(),
			wantIn: "write report",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			results, err := runReport(context.Background(), new(bytes.Buffer), testResolver(t), tc.lister, 0, false, tc.path)
			if err == nil {
				t.Fatal("returned nil; main() reads that as 'the operator has seen the plan' and goes on to --apply")
			}
			if !strings.Contains(err.Error(), tc.wantIn) {
				t.Errorf("error %q does not say %q", err, tc.wantIn)
			}
			if results != nil {
				t.Errorf("returned %d rows alongside an error", len(results))
			}
		})
	}
}
