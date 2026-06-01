package main

// report_test.go — unit tests for the pure reporting helpers:
//   - printSummary (smoke-test: no panic, correct totals)
//   - buildReport  (correct counts, pct, sample accumulation, sample cap)
//   - writeJSON    (file written, valid JSON, error on bad path)
//
// These functions have no DB/network dependency and can be tested in isolation.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// ─── helpers ─────────────────────────────────────────────────────────────────

// makeClassified builds a slice of classified results for the given class
// repeated n times.
func makeClassifiedN(class string, n int) []classified {
	out := make([]classified, n)
	for i := range out {
		out[i] = classified{class: class}
	}
	return out
}

// ─── printSummary ────────────────────────────────────────────────────────────

func TestPrintSummary_ZeroTotal(t *testing.T) {
	t.Parallel()
	// Must not panic when total==0 (avoids divide-by-zero).
	counts := map[string]int{
		ClassAGREE: 0, ClassREBIND: 0, ClassQUARANTINE: 0, ClassHEAL: 0,
	}
	// Capture stdout or simply assert no panic.
	printSummary(0, counts)
}

func TestPrintSummary_NonZeroTotal(t *testing.T) {
	t.Parallel()
	counts := map[string]int{
		ClassAGREE:      80,
		ClassREBIND:     10,
		ClassQUARANTINE: 7,
		ClassHEAL:       3,
	}
	// Should output correct rows without panicking.
	printSummary(100, counts)
}

// ─── buildReport ─────────────────────────────────────────────────────────────

func TestBuildReport_BasicCounts(t *testing.T) {
	t.Parallel()
	results := append(
		makeClassifiedN(ClassAGREE, 5),
		makeClassifiedN(ClassREBIND, 2)...,
	)
	counts := map[string]int{
		ClassAGREE: 5, ClassREBIND: 2, ClassQUARANTINE: 0, ClassHEAL: 0,
	}
	rep := buildReport(7, results, counts)

	if rep.TotalRows != 7 {
		t.Errorf("TotalRows = %d, want 7", rep.TotalRows)
	}
	if rep.Classes[ClassAGREE].Count != 5 {
		t.Errorf("AGREE count = %d, want 5", rep.Classes[ClassAGREE].Count)
	}
	if rep.Classes[ClassREBIND].Count != 2 {
		t.Errorf("REBIND count = %d, want 2", rep.Classes[ClassREBIND].Count)
	}
}

func TestBuildReport_PercentageCalculation(t *testing.T) {
	t.Parallel()
	results := makeClassifiedN(ClassAGREE, 50)
	counts := map[string]int{
		ClassAGREE: 50, ClassREBIND: 0, ClassQUARANTINE: 0, ClassHEAL: 0,
	}
	rep := buildReport(100, results, counts)

	got := rep.Classes[ClassAGREE].Pct
	if got != 50.0 {
		t.Errorf("AGREE pct = %v, want 50.0", got)
	}
	// REBIND: 0/100 = 0.0%
	if rep.Classes[ClassREBIND].Pct != 0.0 {
		t.Errorf("REBIND pct = %v, want 0.0", rep.Classes[ClassREBIND].Pct)
	}
}

func TestBuildReport_ZeroTotalNoDivide(t *testing.T) {
	t.Parallel()
	counts := map[string]int{
		ClassAGREE: 0, ClassREBIND: 0, ClassQUARANTINE: 0, ClassHEAL: 0,
	}
	// Must not panic or produce NaN/Inf.
	rep := buildReport(0, nil, counts)
	for cls, s := range rep.Classes {
		if s.Pct != 0.0 {
			t.Errorf("class %s pct = %v on zero total, want 0.0", cls, s.Pct)
		}
	}
}

func TestBuildReport_SampleCappedAtMaxSamples(t *testing.T) {
	t.Parallel()
	// maxSamples = 50.  Produce 60 AGREE results and verify only 50 are sampled.
	results := makeClassifiedN(ClassAGREE, 60)
	counts := map[string]int{
		ClassAGREE: 60, ClassREBIND: 0, ClassQUARANTINE: 0, ClassHEAL: 0,
	}
	rep := buildReport(60, results, counts)
	if len(rep.Classes[ClassAGREE].Samples) != maxSamples {
		t.Errorf("AGREE samples = %d, want %d (cap)", len(rep.Classes[ClassAGREE].Samples), maxSamples)
	}
}

func TestBuildReport_AllClassesPresent(t *testing.T) {
	t.Parallel()
	results := append(append(append(
		makeClassifiedN(ClassAGREE, 1),
		makeClassifiedN(ClassREBIND, 1)...),
		makeClassifiedN(ClassQUARANTINE, 1)...),
		makeClassifiedN(ClassHEAL, 1)...)
	counts := map[string]int{
		ClassAGREE: 1, ClassREBIND: 1, ClassQUARANTINE: 1, ClassHEAL: 1,
	}
	rep := buildReport(4, results, counts)

	for _, cls := range []string{ClassAGREE, ClassREBIND, ClassQUARANTINE, ClassHEAL} {
		if _, ok := rep.Classes[cls]; !ok {
			t.Errorf("class %s missing from report", cls)
		}
		if rep.Classes[cls].Count != 1 {
			t.Errorf("class %s count = %d, want 1", cls, rep.Classes[cls].Count)
		}
	}
}

func TestBuildReport_GeneratedAtIsSet(t *testing.T) {
	t.Parallel()
	counts := map[string]int{
		ClassAGREE: 0, ClassREBIND: 0, ClassQUARANTINE: 0, ClassHEAL: 0,
	}
	rep := buildReport(0, nil, counts)
	if rep.GeneratedAt.IsZero() {
		t.Error("GeneratedAt must be set to a non-zero time")
	}
}

// ─── writeJSON ────────────────────────────────────────────────────────────────

func TestWriteJSON_WritesValidJSON(t *testing.T) {
	t.Parallel()
	tmp := filepath.Join(t.TempDir(), "out.json")

	data := map[string]any{"key": "value", "num": 42}
	if err := writeJSON(tmp, data); err != nil {
		t.Fatalf("writeJSON returned error: %v", err)
	}

	raw, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatalf("read output file: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("output is not valid JSON: %v\ncontent: %s", err, raw)
	}
	if got["key"] != "value" {
		t.Errorf("key = %v, want value", got["key"])
	}
}

func TestWriteJSON_ErrorOnBadPath(t *testing.T) {
	t.Parallel()
	// Directory that does not exist → os.Create should fail.
	badPath := filepath.Join(t.TempDir(), "no-such-dir", "out.json")
	err := writeJSON(badPath, map[string]any{"x": 1})
	if err == nil {
		t.Error("expected error for non-existent parent dir, got nil")
	}
}

func TestWriteJSON_WritesSlice(t *testing.T) {
	t.Parallel()
	tmp := filepath.Join(t.TempDir(), "slice.json")
	items := []int{1, 2, 3}
	if err := writeJSON(tmp, items); err != nil {
		t.Fatalf("writeJSON returned error: %v", err)
	}
	raw, _ := os.ReadFile(tmp)
	var got []int
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}
	if len(got) != 3 {
		t.Errorf("slice len = %d, want 3", len(got))
	}
}
