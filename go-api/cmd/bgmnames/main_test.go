package main

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bgmnames"
)

// dumpDir makes a directory holding every file the import reads.
func dumpDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "dump-2026-10-06.210359Z")
	require.NoError(t, os.Mkdir(dir, 0o700))
	for _, name := range bgmnames.DumpFiles {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), nil, 0o600))
	}
	return dir
}

// TestParseArgs — a dry run unless --apply, --dump required, and a dump
// directory missing one of the files the import reads is a usage error
// before any database work.
func TestParseArgs(t *testing.T) {
	dir := dumpDir(t)

	opts, samples, err := parseArgs([]string{"--dump", dir}, io.Discard)
	require.NoError(t, err)
	assert.Equal(t, bgmnames.Options{DumpDir: dir}, opts, "a dry run by default")
	assert.Equal(t, 10, samples)

	opts, samples, err = parseArgs([]string{"--dump", dir, "--apply", "--source", "weekly", "--samples", "3"}, io.Discard)
	require.NoError(t, err)
	assert.Equal(t, bgmnames.Options{DumpDir: dir, Source: "weekly", Apply: true}, opts)
	assert.Equal(t, 3, samples)

	_, _, err = parseArgs(nil, io.Discard)
	assert.ErrorContains(t, err, "--dump is required")

	_, _, err = parseArgs([]string{"--dump", dir, "extra"}, io.Discard)
	assert.ErrorContains(t, err, "unexpected argument")

	require.NoError(t, os.Remove(filepath.Join(dir, "person-characters.jsonlines")))
	_, _, err = parseArgs([]string{"--dump", dir}, io.Discard)
	assert.ErrorContains(t, err, "person-characters.jsonlines")
}
