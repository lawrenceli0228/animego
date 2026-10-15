package main

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
)

// Attribution is the credit bangumi-data's CC BY 4.0 licence asks for.  It
// is written into the generated file, so the credit travels with the data.
const Attribution = "Mikan Project bangumi ids from bangumi-data " +
	"(https://github.com/bangumi-data/bangumi-data), licensed under CC BY 4.0 " +
	"(https://creativecommons.org/licenses/by/4.0/). " +
	"Extracted and re-keyed by AniList id and Bangumi subject id by go-api/cmd/mikanmap; do not edit by hand."

// Map is the generated file: the two lookups, the AniList ids left out as
// conflicts, and the bangumi-data release they were built from.
type Map struct {
	Version          string
	Anilist          map[int]int   // AniList id -> Mikan bangumi id
	Bgm              map[int]int   // Bangumi subject id -> Mikan bangumi id
	AnilistConflicts map[int][]int // AniList id -> its Mikan pages; not in Anilist
}

// mapFile is Map's JSON shape, used to read back a map a previous run wrote.
type mapFile struct {
	Attribution      string           `json:"attribution"`
	Version          string           `json:"bangumiDataVersion"`
	Anilist          map[string]int   `json:"anilist"`
	Bgm              map[string]int   `json:"bgm"`
	AnilistConflicts map[string][]int `json:"anilistConflicts"`
}

// Render writes m as JSON, one entry per line and every object sorted by
// numeric id, so a refresh is a reviewable line diff and the same input
// always produces the same bytes.  encoding/json would sort the keys as
// strings ("10" before "9").
func Render(m Map) []byte {
	var b strings.Builder
	b.WriteString("{\n")
	fmt.Fprintf(&b, "  \"attribution\": %s,\n", quote(Attribution))
	fmt.Fprintf(&b, "  \"bangumiDataVersion\": %s,\n", quote(m.Version))
	writeObject(&b, "anilist", m.Anilist, strconv.Itoa, ",")
	writeObject(&b, "bgm", m.Bgm, strconv.Itoa, ",")
	writeObject(&b, "anilistConflicts", m.AnilistConflicts, intList, "")
	b.WriteString("}\n")
	return []byte(b.String())
}

// writeObject writes one JSON object of entries keyed by id, sorted by id,
// with value rendering each value.
func writeObject[V any](b *strings.Builder, name string, entries map[int]V, value func(V) string, trailer string) {
	ids := slices.Sorted(maps.Keys(entries))
	if len(ids) == 0 {
		fmt.Fprintf(b, "  %q: {}%s\n", name, trailer)
		return
	}
	fmt.Fprintf(b, "  %q: {\n", name)
	for i, id := range ids {
		sep := ","
		if i == len(ids)-1 {
			sep = ""
		}
		fmt.Fprintf(b, "    \"%d\": %s%s\n", id, value(entries[id]), sep)
	}
	fmt.Fprintf(b, "  }%s\n", trailer)
}

// intList renders ids as a one-line JSON array.
func intList(ids []int) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.Itoa(id)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// quote JSON-encodes s.  Marshalling a string cannot fail.
func quote(s string) string {
	out, _ := json.Marshal(s)
	return string(out)
}

// ParseMap reads a map Render wrote.
func ParseMap(data []byte) (Map, error) {
	var f mapFile
	if err := json.Unmarshal(data, &f); err != nil {
		return Map{}, fmt.Errorf("decoding map: %w", err)
	}
	anilist, err := intKeys(f.Anilist)
	if err != nil {
		return Map{}, fmt.Errorf("anilist: %w", err)
	}
	bgm, err := intKeys(f.Bgm)
	if err != nil {
		return Map{}, fmt.Errorf("bgm: %w", err)
	}
	conflicts, err := intKeys(f.AnilistConflicts)
	if err != nil {
		return Map{}, fmt.Errorf("anilistConflicts: %w", err)
	}
	return Map{Version: f.Version, Anilist: anilist, Bgm: bgm, AnilistConflicts: conflicts}, nil
}

func intKeys[V any](in map[string]V) (map[int]V, error) {
	out := make(map[int]V, len(in))
	for k, v := range in {
		id, err := strconv.Atoi(k)
		if err != nil {
			return nil, fmt.Errorf("key %q is not an id", k)
		}
		out[id] = v
	}
	return out, nil
}
