#!/usr/bin/env bash
# scripts/refresh-hant-data.sh — re-vendor the Traditional Chinese title datasets
# into go-api/data/hant/.
#
# Two upstreams, both fetched pinned to an exact revision so a run is reproducible:
#   1. soruly/anilist-chinese (MIT) — keyed by AniList id, the trunk.
#      https://github.com/soruly/anilist-chinese
#   2. zh.wikipedia Module:CGroup/Anime (CC BY-SA 4.0) — keyed by title strings,
#      the Hong Kong overlay.
#      https://zh.wikipedia.org/wiki/Module:CGroup/Anime
#
# Refs:
#   GitHub commits API — resolve master to a SHA before downloading, so the raw
#     fetch cannot race an upstream push (anilist-chinese rebuilds daily)
#     https://docs.github.com/en/rest/commits/commits
#   MediaWiki revisions API + action=raw&oldid — same trick for the wiki page
#     https://www.mediawiki.org/wiki/API:Revisions
#   Wikimedia User-Agent policy — identify the client on every request
#     https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy
#
# Determinism: two runs against unchanged upstreams produce byte-identical output.
# Everything is sorted, key order is pinned, no timestamps are written into the
# data files, and every file ends with a newline. `--check` proves it in CI.

set -euo pipefail

MODE="write"
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    -h|--help)
      cat <<'USAGE'
Usage: scripts/refresh-hant-data.sh [--check]

  (no args)  Download both upstreams and rewrite go-api/data/hant/*.json.
  --check    Build into a temp dir and diff against the committed files.
             Writes nothing; exits 1 if they differ. Use this in CI.
USAGE
      exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[refresh-hant] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/go-api/data/hant"

AC_REPO="soruly/anilist-chinese"
AC_FILE="anilist-chinese.json"
CG_PAGE="Module:CGroup/Anime"
CG_WIKI="zh.wikipedia.org"
UA="animego-refresh-hant-data/1.0 (+https://github.com/lawrenceli0228/animego)"

# Truncation floors. Upstream sizes at time of writing: 854 KB and 110 KB.
# A half-written download or an error page lands well under these.
AC_MIN_BYTES=400000
CG_MIN_BYTES=50000

command -v curl    >/dev/null || die "curl not found"
command -v python3 >/dev/null || die "python3 not found"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/refresh-hant.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

# fetch <url> <dest> <min-bytes> [extra curl args...]
# Downloads to <dest> only if the request returns 200 AND the body clears the
# floor. Nothing is written to the repo here, so a bad fetch can never truncate
# a committed file.
fetch() {
  local url="$1" dest="$2" min="$3"; shift 3
  local code size
  code="$(curl -sS -L --max-time 120 --retry 3 --retry-delay 2 \
            -A "$UA" -o "$dest" -w '%{http_code}' "$@" "$url")" \
    || die "curl failed for $url"
  [[ "$code" == "200" ]] || die "$url returned HTTP $code (expected 200)"
  size="$(wc -c < "$dest" | tr -d ' ')"
  [[ "$size" -ge "$min" ]] \
    || die "$url returned $size bytes, below the $min-byte floor — refusing to use a truncated download"
  log "fetched $url ($size bytes)"
}

# --- 1. anilist-chinese: resolve master -> SHA, then fetch that SHA -----------
log "resolving $AC_REPO master"
fetch "https://api.github.com/repos/$AC_REPO/commits/master" "$TMP_DIR/ac-commit.json" 100 \
  -H 'Accept: application/vnd.github+json'
AC_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha"])' "$TMP_DIR/ac-commit.json")"
AC_DATE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"]["committer"]["date"])' "$TMP_DIR/ac-commit.json")"
[[ "$AC_SHA" =~ ^[0-9a-f]{40}$ ]] || die "bad commit sha from GitHub: $AC_SHA"
fetch "https://raw.githubusercontent.com/$AC_REPO/$AC_SHA/$AC_FILE" "$TMP_DIR/ac.json" "$AC_MIN_BYTES"

# --- 2. CGroup/Anime: resolve latest revid, then fetch that oldid -------------
log "resolving $CG_PAGE latest revision"
fetch "https://$CG_WIKI/w/api.php?action=query&prop=revisions&titles=$(printf '%s' "$CG_PAGE" | sed 's|:|%3A|; s|/|%2F|')&rvprop=ids%7Ctimestamp&rvlimit=1&format=json&formatversion=2" \
  "$TMP_DIR/cg-rev.json" 50
CG_REVID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["query"]["pages"][0]["revisions"][0]["revid"])' "$TMP_DIR/cg-rev.json")"
CG_DATE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["query"]["pages"][0]["revisions"][0]["timestamp"])' "$TMP_DIR/cg-rev.json")"
[[ "$CG_REVID" =~ ^[0-9]+$ ]] || die "bad revid from MediaWiki: $CG_REVID"
fetch "https://$CG_WIKI/w/index.php?title=Module%3ACGroup%2FAnime&action=raw&oldid=$CG_REVID" \
  "$TMP_DIR/cg.lua" "$CG_MIN_BYTES"

# --- 3. Normalise into the two vendored JSON files ---------------------------
python3 - "$TMP_DIR/ac.json" "$TMP_DIR/cg.lua" \
           "$TMP_DIR/anilist-chinese.json" "$TMP_DIR/cgroup-hk.json" <<'PY'
# -*- coding: utf-8 -*-
"""Normalise both upstreams into the shapes go-api/internal consumes.

Output contract (both files):
  * one JSON object per line inside a JSON array — compact, and git diffs stay
    line-level instead of reflowing the whole file;
  * key order pinned by construction order, never sorted alphabetically;
  * UTF-8, LF, trailing newline, no BOM.
"""
import io
import json
import re
import sys
from collections import Counter, defaultdict

HAN = re.compile("[㐀-䶿一-鿿豈-﫿]")

# Locale tags used by MediaWiki's Chinese conversion tables.
LANGS = frozenset(("zh", "zh-hans", "zh-hant", "zh-cn", "zh-tw",
                   "zh-hk", "zh-mo", "zh-sg", "zh-my"))
# Real entries always begin at column 0. Anchoring here is what skips the
# usage comment on line 1 -- "-- 用法： Item('原文', '轉換規則')" -- which a
# naive scan for "Item(" picks up as a phantom 792nd entry.
ITEM_RE = re.compile(r"^Item\(\s*(nil|'[^']*'|\"[^\"]*\")\s*,\s*('[^']*'|\"[^\"]*\")\s*\)")
H2_RE = re.compile(r"^==\s*(.+?)\s*==$")
H3_RE = re.compile(r"^===\s*(.+?)\s*===$")
WORKS_SECTION = "作品名"  # 作品名 -- the work-titles section

MIN_ANILIST_ROWS = 5000
MIN_CGROUP_ITEMS = 500


def write_json_lines(path, records):
    out = io.StringIO()
    out.write("[\n")
    last = len(records) - 1
    for i, rec in enumerate(records):
        out.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
        out.write("\n" if i == last else ",\n")
    out.write("]\n")
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(out.getvalue())


def build_anilist(src, dst):
    """{id, title, synonyms} -> sorted by id, trimmed, deduped, blanks dropped.

    synonyms are kept: 776 rows have a Latin-only `title` whose only Chinese
    name lives in `synonyms`, so dropping the field would silently delete those
    rows' entire contribution. Upstream synonym order is preserved rather than
    sorted -- it encodes the curator's preference, and the file order is already
    stable input, so determinism costs nothing here.
    """
    rows = json.load(io.open(src, encoding="utf-8"))
    if not isinstance(rows, list) or len(rows) < MIN_ANILIST_ROWS:
        raise SystemExit("anilist-chinese.json failed its sanity check")

    out = []
    trimmed = blank = dupe = same_as_title = dropped = 0
    for row in rows:
        original = row.get("title") or ""
        title = original.strip()
        if title != original:
            trimmed += 1
        seen, synonyms = set(), []
        for value in row.get("synonyms") or []:
            value = value.strip()
            if not value:
                blank += 1
            elif value == title:
                same_as_title += 1
            elif value in seen:
                dupe += 1
            else:
                seen.add(value)
                synonyms.append(value)
        if not title and not synonyms:
            dropped += 1        # an id with no string at all: nothing to backfill
            continue
        record = {"id": row["id"], "title": title}
        if synonyms:
            record["synonyms"] = synonyms
        out.append(record)

    out.sort(key=lambda r: r["id"])
    write_json_lines(dst, out)

    han = sum(1 for r in out if HAN.search(r["title"]))
    rescued = sum(1 for r in out if not HAN.search(r["title"])
                  and any(HAN.search(s) for s in r.get("synonyms", ())))
    print("[anilist] in=%d out=%d (dropped %d id-only rows)" % (len(rows), len(out), dropped))
    print("[anilist] CJK title=%d  Latin-only title=%d (%d rescued by a CJK synonym, %d with none)"
          % (han, len(out) - han, rescued, len(out) - han - rescued))
    print("[anilist] rows carrying synonyms=%d  synonyms=%d"
          % (sum(1 for r in out if "synonyms" in r),
             sum(len(r.get("synonyms", ())) for r in out)))
    print("[anilist] normalised: %d titles trimmed, %d blank / %d duplicate / "
          "%d title-equal synonyms dropped" % (trimmed, blank, dupe, same_as_title))


def parse_cgroup(src):
    """Item('原文', 'zh-hk:值;原詞=>zh-tw:值;...') -> {zh_hk, keys, section}.

    Two things a regex-only scan gets wrong and this does not: the `原詞=>`
    prefix carries a *source word* that is itself a legitimate join key, and
    MediaWiki leftovers such as `}--{-|TOUCH` are not lang:value pairs and must
    be discarded rather than merged into the previous locale.
    """
    items, section = [], None
    for line in io.open(src, encoding="utf-8"):
        line = line.rstrip("\n")
        stripped = line.strip()
        if H3_RE.match(stripped):
            continue                        # subsection; the level-2 heading still governs
        heading = H2_RE.match(stripped)
        if heading:
            section = heading.group(1)
            continue
        if not line.startswith("Item("):
            continue
        matched = ITEM_RE.match(line)
        if not matched:
            raise SystemExit("unparsed Item(): %s" % line[:120])

        raw = None if matched.group(1) == "nil" else matched.group(1)[1:-1]
        keys, hk_plain, hk_conditional = set(), None, []
        for segment in matched.group(2)[1:-1].split(";"):
            segment = segment.strip()
            if not segment:
                continue
            conditional = "=>" in segment
            if conditional:
                source_word, segment = segment.split("=>", 1)
                source_word = source_word.strip()
                if source_word:
                    keys.add(source_word)
            if ":" not in segment:
                continue                    # e.g. }--{-|TOUCH
            lang, value = segment.split(":", 1)
            lang, value = lang.strip().lower(), value.strip()
            if lang not in LANGS or not value:
                continue
            keys.add(value)
            if lang == "zh-hk":
                if conditional:
                    hk_conditional.append(value)
                elif hk_plain is None:
                    hk_plain = value
        if raw:
            keys.add(raw)

        zh_hk = hk_plain
        if zh_hk is None and hk_conditional:
            zh_hk = hk_conditional[0]
        items.append((zh_hk, section, keys))
    return items


def build_cgroup(src, dst):
    """Keep work titles that carry a zh-hk value; emit every possible join key."""
    items = parse_cgroup(src)
    if len(items) < MIN_CGROUP_ITEMS:
        raise SystemExit("CGroup parse produced only %d items" % len(items))

    kept, seen = [], set()
    no_hk = off_section = duplicate = 0
    for zh_hk, section, keys in items:
        if not zh_hk:
            no_hk += 1              # zh-tw / zh-hant only: nothing for an HK overlay
        elif section != WORKS_SECTION:
            off_section += 1        # 術語 / 人名: not titles, joining them invents matches
        else:
            signature = (zh_hk, tuple(sorted(keys)))
            if signature in seen:
                duplicate += 1
            else:
                seen.add(signature)
                kept.append({"zh_hk": zh_hk, "keys": sorted(keys)})

    kept.sort(key=lambda r: (r["zh_hk"], r["keys"]))
    write_json_lines(dst, kept)

    per_key = defaultdict(set)
    for record in kept:
        for key in record["keys"]:
            per_key[key].add(record["zh_hk"])
    ambiguous = sorted(k for k, v in per_key.items() if len(v) > 1)
    sections = Counter(section for _, section, _ in items)
    print("[cgroup] Item() calls=%d  per section=%s"
          % (len(items), dict(sorted(sections.items(), key=lambda kv: -kv[1]))))
    print("[cgroup] kept=%d  dropped: %d without zh-hk, %d outside %s, %d identical duplicates"
          % (len(kept), no_hk, off_section, WORKS_SECTION, duplicate))
    print("[cgroup] distinct join keys=%d  ambiguous (one key, several zh-hk)=%d"
          % (len(per_key), len(ambiguous)))
    if ambiguous:
        print("[cgroup] ambiguous keys: %s" % ", ".join(ambiguous))


build_anilist(sys.argv[1], sys.argv[3])
build_cgroup(sys.argv[2], sys.argv[4])
PY

# --- 4. Install, or diff in --check mode -------------------------------------
if [[ "$MODE" == "check" ]]; then
  status=0
  for name in anilist-chinese.json cgroup-hk.json; do
    if diff -q "$OUT_DIR/$name" "$TMP_DIR/$name" >/dev/null 2>&1; then
      log "OK    $name matches a fresh build"
    else
      log "DRIFT $name differs from a fresh build"
      status=1
    fi
  done
  [[ "$status" -eq 0 ]] || die "committed data is stale — re-run without --check"
  log "check passed"
  exit 0
fi

mkdir -p "$OUT_DIR"
for name in anilist-chinese.json cgroup-hk.json; do
  mv "$TMP_DIR/$name" "$OUT_DIR/$name"
  log "wrote $OUT_DIR/$name ($(wc -c < "$OUT_DIR/$name" | tr -d ' ') bytes)"
done

# Provenance is not written into the data files — a timestamp in there would
# break byte-for-byte reproducibility. Paste this block into the README instead.
cat >&2 <<EOF

  Paste into go-api/data/hant/README.md:

  | anilist-chinese.json | $AC_REPO@\`${AC_SHA:0:12}\` | committed $AC_DATE |
  | cgroup-hk.json       | $CG_PAGE oldid=$CG_REVID | revised $CG_DATE |

  fetched $(date -u +%Y-%m-%d)
EOF
log "done"
