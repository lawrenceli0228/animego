package animerelations

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func doc(rules ...string) []byte {
	return []byte(strings.Join(append([]string{
		"# header",
		"::meta",
		"- version: 1.3.0",
		"- last_modified: 2026-10-19",
		"::rules",
		"# a comment",
		"",
	}, rules...), "\n") + "\n")
}

func TestShiftsForATarget(t *testing.T) {
	// Fansubs number San no Shou continuously across its two cours: Part 2
	// opens on "13".  The rule says 13–25 are Part 2's 1–13, a shift of 12.
	r, err := Parse(doc("- 51818|46119|149118:13-25 -> 59229|49016|179062:1-13!"))
	require.NoError(t, err)
	assert.Equal(t, []int32{12}, r.Shifts(179062))
	assert.Empty(t, r.Shifts(149118), "a rule says nothing about its source's own numbering")
	assert.Equal(t, "2026-10-19", r.LastModified())
}

func TestShiftsWithoutTheSelfRedirectMark(t *testing.T) {
	// "!" makes Taiga, which identifies files by title, also apply the rule
	// to a file it already took for the target.  The library identifies by
	// hash and binds the target, so the shift holds either way.
	r, err := Parse(doc("- 31646|11380|21366:23-44 -> 35180|13401|98478:1-22"))
	require.NoError(t, err)
	assert.Equal(t, []int32{22}, r.Shifts(98478))
}

func TestATildeTargetIsTheSourceItself(t *testing.T) {
	r, err := Parse(doc(
		"- 58749|48796|177175:17-26 -> ~|~|~:1-10",
		"- 33820|12478|21898:0 -> ~|~|~:1",
	))
	require.NoError(t, err)
	assert.Equal(t, []int32{16}, r.Shifts(177175))
	assert.Equal(t, []int32{-1}, r.Shifts(21898), "an episode 0 moves up to 1")
}

func TestAnOpenRange(t *testing.T) {
	r, err := Parse(doc("- 34572|13209|97940:171-? -> 61967|50024|195604:1-?!"))
	require.NoError(t, err)
	assert.Equal(t, []int32{170}, r.Shifts(195604))
}

func TestShiftsAreDistinctAndInFileOrder(t *testing.T) {
	r, err := Parse(doc(
		"- 1|1|10:13-24 -> 2|2|20:1-12",
		"- 1|1|10:25-36 -> 2|2|20:13-24",
		"- 3|3|30:0 -> 2|2|20:1",
	))
	require.NoError(t, err)
	assert.Equal(t, []int32{12, -1}, r.Shifts(20))
}

func TestATargetWithoutAnAniListIDIsSkipped(t *testing.T) {
	r, err := Parse(doc(
		"- ?|7205|15061:51-101 -> ?|7972|?:1-51",
		"- ?|7205|15061:102-152 -> ?|9096|20794:1-51",
	))
	require.NoError(t, err)
	assert.Equal(t, []int32{101}, r.Shifts(20794))
}

func TestANoOpRuleIsNotAShift(t *testing.T) {
	r, err := Parse(doc("- 1|1|10:1-12 -> 2|2|20:1-12"))
	require.NoError(t, err)
	assert.Empty(t, r.Shifts(20))
}

func TestMalformedRulesAreRejected(t *testing.T) {
	for _, line := range []string{
		"- 51818|46119|149118 13-25 -> 59229|49016|179062:1-13",
		"- 51818|46119:13-25 -> 59229|49016|179062:1-13",
		"- 51818|46119|149118:x -> 59229|49016|179062:1-13",
		"- 51818|46119|149118:13-25 => 59229|49016|179062:1-13",
	} {
		_, err := Parse(doc(line))
		assert.Error(t, err, "line %q", line)
	}
}

func TestRulesBeforeTheRulesSectionAreRejected(t *testing.T) {
	_, err := Parse([]byte("- 1|1|10:13-24 -> 2|2|20:1-12\n"))
	assert.Error(t, err)
}

func TestTheEmbeddedFileParses(t *testing.T) {
	r, err := Parse(raw)
	require.NoError(t, err)
	assert.Greater(t, r.RuleCount(), 400)
	assert.NotEmpty(t, r.LastModified())
	assert.Contains(t, r.Shifts(179062), int32(12))
	assert.Same(t, Default(), Default())
	assert.Equal(t, r.RuleCount(), Default().RuleCount())
}
