# Traditional Chinese title data

Vendored, network-free inputs for the `zh-Hant` title backfill: two tiers of
**human** translations, plus the dictionary the machine-converted tail is
produced from.

| File | What it is | Rows | Licence |
| --- | --- | --- | --- |
| `anilist-chinese.json` | The trunk. Traditional titles keyed by **AniList id**, so it joins `anime_cache.anilist_id` directly with no fuzzy matching. | 8,492 | MIT |
| `cgroup-hk.json` | The Hong Kong overlay. Keyed by **title strings** only — no ids anywhere. | 628 | CC BY-SA 4.0 |
| `opencc-s2twp.txt` | The tail. OpenCC's `s2twp` conversion chain, flattened. Not translations — a character and phrase mapping. | 53,579 | Apache-2.0 |
| `LICENSE-anilist-chinese` | MIT text, soruly's copyright line. | | |
| `LICENSE-cgroup` | CC BY-SA 4.0 notice, attribution, changes made, share-alike terms. | | |
| `LICENSE-opencc` | Apache-2.0 text, OpenCC attribution, changes made. | | |

Everything here is consumed by `go-api/cmd/hantbackfill`, which is the only
writer of the `*_hant` columns migration 0022 added.

## Provenance

Fetched **2026-08-20**. Every upstream is pinned to an exact revision, so
these bytes are reproducible.

| File | Upstream | Revision | SHA-256 of the upstream source |
| --- | --- | --- | --- |
| `anilist-chinese.json` | <https://github.com/soruly/anilist-chinese> (`anilist-chinese.json`) | commit `de9f4d6ed6deb510ca2ba9f42998d0ee6424a7c4`, committed 2026-08-20T00:51:14Z | `3a7a0044532ad21dd5b18108d80e7b03543a45b456725030bd98bb99ec333044` |
| `cgroup-hk.json` | <https://zh.wikipedia.org/wiki/Module:CGroup/Anime> | [`oldid=93691696`](https://zh.wikipedia.org/w/index.php?title=Module:CGroup/Anime&oldid=93691696), revised 2026-07-29T11:54:00Z | `b61332a4cde6db6fd09741163c8b26f4ea61db20783961fba00de2ff89b37967` |
| `opencc-s2twp.txt` | <https://github.com/BYVoid/OpenCC> dictionaries, by way of `opencc-python-reimplemented` 0.1.7 | `STPhrases.txt` `a4de4d24…c586`, `STCharacters.txt` `9207708d…cac5`, `TWPhrases.txt` `2ac64976…6f07`, `TWVariants.txt` `30e6f839…34d7` | (per-dictionary, recorded on each `@dict` line in the file itself) |

Upstream `anilist-chinese.json` rebuilds **daily**, so its commit SHA moves even
when the content does not. The SHA-256 column is the stable identity.

`scripts/refresh-hant-data.sh` re-vendors the two JSON datasets;
`scripts/gen-opencc-s2twp.py` regenerates the conversion table. Both have a
`--check` mode that proves the committed bytes still match without writing.

## Shape

One JSON object per line inside a JSON array — compact, and git diffs stay
line-level instead of reflowing the whole file. UTF-8, LF, trailing newline.

```jsonc
// anilist-chinese.json — sorted by id ascending; "synonyms" omitted when empty
{"id":1,"title":"星際牛仔"}
{"id":6,"title":"Trigun","synonyms":["槍神Trigun"]}

// cgroup-hk.json — sorted by (zh_hk, keys); "keys" sorted by code point
{"zh_hk":"夢幻街少女","keys":["侧耳倾听","夢幻街少女","心之谷","梦幻街少女","耳をすませば"]}
```

`opencc-s2twp.txt` is not JSON. It is upstream OpenCC's own `KEY<TAB>VALUE`
dictionary format, with `@group` / `@dict` markers carrying the chain
structure that `s2twp` is defined by. `#` comments and blank lines are
ignored; a `VALUE` may hold space-separated alternatives, of which the first
is the default.

```text
@group
@dict STPhrases.txt a4de4d24…c586
一丝不挂	一絲不掛
@dict STCharacters.txt 9207708d…cac5
干	幹 乾 干
@group
@dict TWPhrases.txt 2ac64976…6f07
软件	軟體
```

## Consuming this from Go

**`anilist-chinese.json`** — join on `id` → `anime_cache.anilist_id`. Four
things the data will do to you:

- **1,833 of 8,492 titles are Latin, not Chinese.** For 776 of those the Chinese
  name is in `synonyms` instead (`{"title":"One Piece","synonyms":["海賊王","航海王"]}`),
  so the backfill must fall back to the first CJK synonym when `title` has no
  Han characters. The remaining 1,057 have no Chinese anywhere — decide whether
  a Latin string is an acceptable `zh-Hant` value before writing it.
- **957 titles contain kana**, i.e. they are the Japanese original passed
  through rather than a translation. Screen for kana if that matters.
- Upstream synonym order is **preserved, not sorted** — it encodes the curator's
  preference, so "first CJK synonym" is a meaningful pick.
- Rows are normalised on the way in: titles trimmed, blank / duplicate /
  title-equal synonyms dropped, and six id-only rows with no strings at all
  removed. Nothing else is filtered.

**`cgroup-hk.json`** — try every entry in `keys` against both
`anime_cache.title_native` **and** `title_chinese`, and write `zh_hk` on a hit.
`keys` deliberately holds every string the entry contained: the Japanese
original, the Simplified values, the zh-cn / zh-tw / zh-hant variants, the
`原詞=>` conversion source words, and the zh-hk value itself. The Japanese
original matches more often than the Chinese one, because CGroup's first
argument is usually the Japanese title.

- **17 keys map to more than one `zh_hk`** and must be skipped rather than
  resolved last-write-wins. They are genuine upstream ambiguity, not parse
  damage — `心之谷` is the Taiwanese title of *Whisper of the Heart* and also a
  Hong Kong title of its sequel; `ハングリーハート WILD STRIKER` has different
  Hong Kong names for the manga and the anime. Build the key map, detect
  collisions, drop them.
- Normalise **both sides identically** before comparing. These are raw upstream
  strings; no case folding, width folding, or punctuation stripping has been
  applied.

**`opencc-s2twp.txt`** — a conversion chain, not a lookup table. Apply the
stages in file order; within a `@group`, the first `@dict` that matches a
prefix wins, which is what makes phrases beat single characters. At each
position take the **longest key that prefixes the remaining text**, emit its
first value, and advance past it; on no match copy one rune. That is upstream
OpenCC's algorithm, and it is ~70 lines
(`go-api/cmd/hantbackfill/opencc.go`).

- Two of the dictionaries are one-to-many (`干 → 幹 乾 干`). Conversion uses
  only the first value, but the rest matter: a character that appears among
  its **own** alternatives exists in Traditional too, which is how the
  backfill tells 学 (Simplified only) from 里 (both) without a hand-written
  list.
- `STPhrases.txt` has no single-rune keys — all 49,051 of its keys are two
  runes or longer. The Simplified check relies on that to identify the
  character dictionary by shape rather than by filename.
- This is a **machine** conversion and is not a translation. It does not know
  that Taiwan calls the show 進擊的巨人, and it will not invent 鬼滅之刃 from
  its neighbours. Anything derived from it is written with `source='opencc'`,
  which migration 0022's generated `title_hant_seo` column keeps out of
  search results.

### What the backfill actually enforces

`cmd/hantbackfill` is slightly stricter than the notes above, and the
difference is deliberate: a synonym is only accepted if it clears **all**
three rules, not just "has a CJK character". Measured over the vendored file,
that rescues 773 of the 1,833 Latin titles rather than 776, and it also lets
kana- and Simplified-rejected primaries reach their synonyms, which rescues
13 rows the "no Han only" reading would have dropped.

## Refreshing

```bash
./scripts/refresh-hant-data.sh          # re-download and rewrite both JSON files
./scripts/refresh-hant-data.sh --check  # build into a temp dir and diff; writes nothing

python3 scripts/gen-opencc-s2twp.py         # rebuild opencc-s2twp.txt
python3 scripts/gen-opencc-s2twp.py --check # diff against the committed file
```

The script resolves each upstream to a revision **first**, then downloads that
revision, so a fetch cannot race an upstream push. It refuses to replace a
committed file unless the request returned HTTP 200 and the body cleared a size
floor, so a truncated download or an error page can never land here. Two runs
against unchanged upstreams produce byte-identical files; `--check` proves it.

Provenance is deliberately **not** written into the two JSON data files — a
fetch timestamp in there would break that reproducibility. The script prints a
provenance block at the end; paste it into the tables above.

`gen-opencc-s2twp.py` reads the dictionaries out of the installed
`opencc-python-reimplemented` package rather than downloading them, so the
pin is the package version. It records each dictionary's SHA-256 on its
`@dict` line, so the vendored file carries its own provenance and `--check`
catches a silent upgrade underneath it. It fails rather than resolve a
duplicate key or a malformed line.

## Why this directory is isolated

`cgroup-hk.json` is **CC BY-SA 4.0**, a share-alike licence. The rest of this
repository is **AGPL-3.0**. Keeping the CC BY-SA material in a data-only
directory, with its own licence notice and no source code mixed in, bounds the
share-alike obligation to a file whose boundary is obvious to anyone reading the
tree — rather than letting a share-alike dataset bleed into AGPL source where
the licence boundary would have to be reconstructed from commit history.

Nothing in this directory is Go source. Do not add code here, and do not paste
CGroup values into files outside it.

**The CGroup data requires attribution wherever its values are displayed** — not
only where the file is redistributed. Any page, API response, or export that
shows a Hong Kong title sourced from `cgroup-hk.json` needs a visible credit to
Wikipedia's `Module:CGroup/Anime` linking to the source page and to the
CC BY-SA 4.0 deed. See `LICENSE-cgroup` for the exact terms and the list of
changes made.

`anilist-chinese.json` is MIT and carries no such display obligation — only the
copyright notice in `LICENSE-anilist-chinese`, which must travel with any
redistribution.

`opencc-s2twp.txt` is **Apache-2.0**, which is permissive and imposes no
share-alike obligation on anything that reads it. It lives here because this
is where vendored data lives, not because it constrains AGPL source the way
`cgroup-hk.json` does. Redistribution needs the licence copy and attribution
in `LICENSE-opencc`.
