// How many people the detail page lays out, shared between the sections
// that draw them and the JSON-LD that describes them.
//
// The API returns a whole AniList page (25 characters, 25 staff -- up from
// 8 and 10) so the ids behind them can be stored for the person pages; the
// page keeps drawing what it drew before, because the people grid is one
// column on a phone and 25 rows of it would push the episode list off the
// first two screens. A "view all" belongs to the person-page work, not here.
//
// The structured data reads the same slice. Google's guideline is to mark
// up what the reader can see, and a machine-readable cast list that names
// twenty-five people beside a visible eight would be exactly the kind of
// claim it means.
export const DETAIL_CHARACTERS_SHOWN = 8;
export const DETAIL_STAFF_SHOWN = 10;
