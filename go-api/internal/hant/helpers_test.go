package hant

import (
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

// dataDir resolves go-api/data/hant from this source file's location, so
// the tests do not care what directory `go test` was invoked from.
// testutil.migrationsDirAbs does the same thing for the same reason.
func dataDir(t *testing.T) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// internal/hant/helpers_test.go -> internal/hant -> internal -> go-api
	return filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(self))), "data", "hant")
}

// The vendored files are shared, read-only and non-trivial to parse (the
// conversion table alone is 53,579 entries), so every test in this package
// gets the same loaded copy.
var (
	loadConvOnce  sync.Once
	sharedConv    *Converter
	sharedConvErr error

	loadResOnce  sync.Once
	sharedRes    *Resolver
	sharedResErr error
)

func testConverter(t *testing.T) *Converter {
	t.Helper()
	loadConvOnce.Do(func() {
		sharedConv, sharedConvErr = LoadConverter(filepath.Join(dataDir(t), openccFile))
	})
	if sharedConvErr != nil {
		t.Fatalf("LoadConverter: %v", sharedConvErr)
	}
	return sharedConv
}

func testResolver(t *testing.T) *Resolver {
	t.Helper()
	loadResOnce.Do(func() {
		sharedRes, sharedResErr = NewResolverFromDir(dataDir(t))
	})
	if sharedResErr != nil {
		t.Fatalf("NewResolverFromDir: %v", sharedResErr)
	}
	return sharedRes
}

func testGate(t *testing.T) *gate {
	t.Helper()
	return testResolver(t).gate
}

func ptr(s string) *string { return &s }
