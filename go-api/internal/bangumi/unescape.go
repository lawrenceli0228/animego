package bangumi

import "html"

// Bangumi's API returns user-entered text HTML-escaped — "CAROLE &amp;
// TUESDAY", episode names with &quot; and &lt;…&gt;.  Every field below ends
// up as plain text on a page, where React escapes it again, so stored as is
// it reads as the literal entity.  Decode here, where the text enters the
// system, rather than in each consumer.
//
// Until stable, not once: a handful of Bangumi episode names are escaped
// twice ("レーベモン&amp;amp;カイザーレオモン", "&amp;quot;Romeo und
// Julia&amp;quot;"), and every one of them means the plain character.  A
// title that genuinely needs the text "&amp;" does not exist in the
// catalogue; one that renders as "&amp;amp;" did.

// maxUnescapePasses bounds decode for pathological input; real data needs two.
const maxUnescapePasses = 3

// decode HTML-unescapes s until it stops changing.
func decode(s string) string {
	for range maxUnescapePasses {
		next := html.UnescapeString(s)
		if next == s {
			break
		}
		s = next
	}
	return s
}

func (r *SearchResponse) unescape() {
	for i := range r.List {
		r.List[i].Name = decode(r.List[i].Name)
		r.List[i].NameCN = decode(r.List[i].NameCN)
	}
}

func (s *Subject) unescape() {
	s.Name = decode(s.Name)
	s.NameCN = decode(s.NameCN)
	s.Summary = decode(s.Summary)
	for i := range s.Tags {
		s.Tags[i].Name = decode(s.Tags[i].Name)
	}
}

func (r *EpisodesResponse) unescape() {
	for i := range r.Eps {
		r.Eps[i].Name = decode(r.Eps[i].Name)
		r.Eps[i].NameCN = decode(r.Eps[i].NameCN)
	}
}

func unescapeCharacters(cs []Character) {
	for i := range cs {
		cs[i].Name = decode(cs[i].Name)
		cs[i].NameCN = decode(cs[i].NameCN)
		for j := range cs[i].Actors {
			cs[i].Actors[j].Name = decode(cs[i].Actors[j].Name)
			cs[i].Actors[j].NameCN = decode(cs[i].Actors[j].NameCN)
		}
	}
}
