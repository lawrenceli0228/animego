package anime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

type offsetQuerier struct {
	dbgen.Querier
	one  map[int32]int32 // anilistId -> known offset
	many []dbgen.GetAbsoluteEpisodeOffsetsRow
}

func (q *offsetQuerier) GetAbsoluteEpisodeOffset(_ context.Context, id int32) (dbgen.GetAbsoluteEpisodeOffsetRow, error) {
	off, ok := q.one[id]
	if !ok {
		return dbgen.GetAbsoluteEpisodeOffsetRow{}, pgx.ErrNoRows
	}
	known := true
	return dbgen.GetAbsoluteEpisodeOffsetRow{Known: &known, AbsoluteOffset: off}, nil
}

func (q *offsetQuerier) GetAbsoluteEpisodeOffsets(_ context.Context, _ []int32) ([]dbgen.GetAbsoluteEpisodeOffsetsRow, error) {
	return q.many, nil
}

type fixedShifts map[int32][]int32

func (f fixedShifts) Shifts(id int32) []int32 { return f[id] }

func getJSON(t *testing.T, h http.HandlerFunc, path string, params map[string]string) map[string]json.RawMessage {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if params != nil {
		rctx := chi.NewRouteContext()
		for k, v := range params {
			rctx.URLParams.Add(k, v)
		}
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var env map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	return env
}

func TestEpisodeOffset_CarriesTheRuleShifts(t *testing.T) {
	// San no Shou Part 2: the walk sums every earlier season (60), the
	// release groups' numbering is shifted by 12.
	q := &offsetQuerier{one: map[int32]int32{179062: 60}}
	env := getJSON(t, EpisodeOffset(q, fixedShifts{179062: {12}}), "/", map[string]string{"anilistId": "179062"})

	var data struct {
		Known       bool    `json:"known"`
		Offset      int32   `json:"offset"`
		RuleOffsets []int32 `json:"ruleOffsets"`
	}
	require.NoError(t, json.Unmarshal(env["data"], &data))
	assert.True(t, data.Known)
	assert.Equal(t, int32(60), data.Offset)
	assert.Equal(t, []int32{12}, data.RuleOffsets)
}

func TestEpisodeOffset_AnUncachedIDStillGetsItsRules(t *testing.T) {
	q := &offsetQuerier{one: map[int32]int32{}}
	env := getJSON(t, EpisodeOffset(q, fixedShifts{5: {12}}), "/", map[string]string{"anilistId": "5"})
	assert.JSONEq(t, `{"known":false,"offset":0,"ruleOffsets":[12]}`, string(env["data"]))
}

func TestEpisodeOffset_NoRuleNoField(t *testing.T) {
	q := &offsetQuerier{one: map[int32]int32{7: 0}}
	env := getJSON(t, EpisodeOffset(q, fixedShifts{}), "/", map[string]string{"anilistId": "7"})
	assert.JSONEq(t, `{"known":true,"offset":0}`, string(env["data"]))
}

func TestEpisodeOffsets_CarryRulesAndAnswerUncachedIDsThatHaveThem(t *testing.T) {
	known := true
	q := &offsetQuerier{many: []dbgen.GetAbsoluteEpisodeOffsetsRow{
		{AnilistID: 179062, Known: &known, AbsoluteOffset: 60},
		{AnilistID: 8, Known: &known, AbsoluteOffset: 0},
	}}
	rules := fixedShifts{179062: {12}, 9: {24}}
	env := getJSON(t, EpisodeOffsets(q, rules), "/?ids=179062,8,9,10", nil)
	assert.JSONEq(t, `[
		{"anilistId":179062,"known":true,"offset":60,"ruleOffsets":[12]},
		{"anilistId":8,"known":true,"offset":0},
		{"anilistId":9,"known":false,"offset":0,"ruleOffsets":[24]}
	]`, string(env["data"]))
}
