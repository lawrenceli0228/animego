package bangumi

// Bangumi's API returns user-entered text HTML-escaped: titles such as
// "CAROLE &amp; TUESDAY", episode names with &quot; and &lt;…&gt;.  Stored as
// is, every one of them reaches a page as the literal entity, because React
// escapes the text again on render.  The client decodes once, where the text
// enters the system, so no consumer has to remember to.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func serve(t *testing.T, body string) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, body)
	}))
	t.Cleanup(srv.Close)
	return testClient(t, srv.URL)
}

func TestClient_Search_DecodesEntities(t *testing.T) {
	t.Parallel()
	c := serve(t, `{"list":[{"id":1,"name":"CAROLE &amp; TUESDAY","name_cn":"宝可梦 太阳&amp;月亮"}]}`)

	resp, err := c.Search(context.Background(), "x")
	require.NoError(t, err)
	require.Len(t, resp.List, 1)
	assert.Equal(t, "CAROLE & TUESDAY", resp.List[0].Name)
	assert.Equal(t, "宝可梦 太阳&月亮", resp.List[0].NameCN)
}

func TestClient_Subject_DecodesEntities(t *testing.T) {
	t.Parallel()
	c := serve(t, `{"id":2,"name":"春&amp;夏","name_cn":"笑对昙天 &lt;外传&gt;",
	  "summary":"他说：&quot;走吧&quot;，那是他&#39;s 选择",
	  "tags":[{"name":"A&amp;B","count":3}]}`)

	s, err := c.Subject(context.Background(), 2)
	require.NoError(t, err)
	assert.Equal(t, "春&夏", s.Name)
	assert.Equal(t, "笑对昙天 <外传>", s.NameCN)
	assert.Equal(t, `他说："走吧"，那是他's 选择`, s.Summary)
	require.Len(t, s.Tags, 1)
	assert.Equal(t, "A&B", s.Tags[0].Name)
}

func TestClient_Episodes_DecodesEntities(t *testing.T) {
	t.Parallel()
	c := serve(t, `{"eps":[{"id":3,"sort":1,"type":0,"name":"Ayu&amp;Nina","name_cn":"&quot;一&quot;"}]}`)

	resp, err := c.Episodes(context.Background(), 3)
	require.NoError(t, err)
	require.Len(t, resp.Eps, 1)
	assert.Equal(t, "Ayu&Nina", resp.Eps[0].Name)
	assert.Equal(t, `"一"`, resp.Eps[0].NameCN)
}

func TestClient_Characters_DecodesEntities(t *testing.T) {
	t.Parallel()
	c := serve(t, `[{"id":4,"name":"Ed &amp; Al","name_cn":"&lt;甲&gt;","relation":"主角",
	  "actors":[{"id":5,"name":"O&#39;Neil","name_cn":"A&amp;B"}]}]`)

	cs, err := c.Characters(context.Background(), 4)
	require.NoError(t, err)
	require.Len(t, cs, 1)
	assert.Equal(t, "Ed & Al", cs[0].Name)
	assert.Equal(t, "<甲>", cs[0].NameCN)
	require.Len(t, cs[0].Actors, 1)
	assert.Equal(t, "O'Neil", cs[0].Actors[0].Name)
	assert.Equal(t, "A&B", cs[0].Actors[0].NameCN)
}

// A few Bangumi episode names are escaped twice; they mean the plain
// character, so decoding runs until the text stops changing.
func TestClient_DecodesNestedEscaping(t *testing.T) {
	t.Parallel()
	c := serve(t, `{"eps":[{"id":7,"sort":33,"type":0,"name":"レーベモン&amp;amp;カイザーレオモン","name_cn":"&amp;quot;Romeo&amp;quot;"}]}`)

	resp, err := c.Episodes(context.Background(), 7)
	require.NoError(t, err)
	require.Len(t, resp.Eps, 1)
	assert.Equal(t, "レーベモン&カイザーレオモン", resp.Eps[0].Name)
	assert.Equal(t, `"Romeo"`, resp.Eps[0].NameCN)
}

func TestDecode_StopsWhenStableAndIsBounded(t *testing.T) {
	t.Parallel()
	assert.Equal(t, "plain & simple", decode("plain & simple"))
	assert.Equal(t, "&", decode("&amp;amp;amp;"))
	// Deeper than maxUnescapePasses: bounded, not looped forever.
	assert.Equal(t, "&amp;", decode("&amp;amp;amp;amp;"))
}
