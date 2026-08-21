#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate go-api/data/hant/opencc-s2twp.txt — the vendored s2twp table.

Why a generated table instead of a Go OpenCC binding
====================================================
There is no maintained pure-Go OpenCC.  The two ports that exist
(liuzl/gocc, longbridgeapp/opencc) both embed their own snapshot of the
same dictionaries and have not tracked upstream for years, so adopting
one would mean depending on an unpinned copy of exactly the data this
script vendors -- with the version buried in go.sum instead of written
down.

So the dictionaries are vendored directly and the conversion algorithm
lives in cmd/hantbackfill/opencc.go, which is ~70 lines.  That makes the
conversion:

  deterministic   pure function of (input, table, algorithm), no clock,
                  no map iteration, no locale.
  re-derivable    re-run this script against the same pinned OpenCC
                  release and the output is byte-identical; `--check`
                  proves it without writing.
  reviewable      the table is the upstream dictionaries in upstream's
                  own TSV format, so a diff against a new OpenCC release
                  is readable line by line.

What s2twp is
=============
Not one dictionary -- a three-stage chain, from OpenCC's own
config/s2twp.json:

  stage 1  group(STPhrases, STCharacters)   Simplified -> Traditional
  stage 2  TWPhrases                        Taiwan vocabulary
  stage 3  TWVariants                       Taiwan character variants

Order matters and the stages are NOT mergeable into one table: stage 2
matches against text stage 1 already produced.  Inside a group the first
dictionary that yields a prefix match wins, which is what makes phrases
beat characters (OpenCC DictGroup::MatchPrefix).  The generated file
preserves both structures with @group / @dict markers.

Usage
=====
    python3 scripts/gen-opencc-s2twp.py            # write the table
    python3 scripts/gen-opencc-s2twp.py --check    # diff only, writes nothing

Requires the `opencc` python package (opencc-python-reimplemented), which
ships the upstream dictionaries as plain TSV.  Only its *data* is used --
its converter is not, because it is a reimplementation whose match
strategy differs from upstream C++ OpenCC (see opencc.go).
"""
from __future__ import unicode_literals

import argparse
import hashlib
import io
import json
import os
import sys

OUT_REL = os.path.join("go-api", "data", "hant", "opencc-s2twp.txt")
CONFIG = "s2twp"


def opencc_paths():
    try:
        import opencc
    except ImportError:
        sys.exit(
            "error: the `opencc` python package is not installed.\n"
            "       pip install opencc-python-reimplemented"
        )
    pkg = os.path.dirname(os.path.abspath(opencc.__file__))
    return pkg, os.path.join(pkg, "config"), os.path.join(pkg, "dictionary")


def package_version():
    try:
        # importlib.metadata is 3.8+; fall back to "unknown" rather than fail.
        from importlib.metadata import version

        return version("opencc-python-reimplemented")
    except Exception:
        return "unknown"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def chain_from_config(config_dir, dict_dir):
    """Read config/<CONFIG>.json and return [[dictfile, ...], ...].

    A bare dict becomes a one-element group so the Go side has exactly one
    shape to parse.
    """
    with io.open(os.path.join(config_dir, CONFIG + ".json"), encoding="utf-8") as f:
        cfg = json.load(f)

    groups = []
    for link in cfg["conversion_chain"]:
        d = link["dict"]
        if d.get("type") == "group":
            members = d["dicts"]
        else:
            members = [d]
        files = []
        for m in members:
            if m.get("type") != "txt":
                sys.exit(
                    "error: %s references a non-txt dictionary (%r); this "
                    "generator only understands the plain-text dictionaries."
                    % (CONFIG, m.get("type"))
                )
            files.append(os.path.join(dict_dir, m["file"]))
        groups.append(files)
    return cfg.get("name", CONFIG), groups


def read_dict(path):
    """Read one upstream TSV dictionary as an ordered list of (key, values).

    Upstream order is preserved verbatim.  Duplicate keys are a data error
    upstream and are reported rather than silently collapsed, because the
    Go loader builds a map and would drop one.
    """
    entries = []
    seen = {}
    with io.open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.rstrip("\n").rstrip("\r")
            if not line:
                continue
            parts = line.split("\t")
            if len(parts) != 2:
                sys.exit("error: %s:%d is not KEY<TAB>VALUE" % (path, lineno))
            key, value = parts
            if not key or not value:
                sys.exit("error: %s:%d has an empty key or value" % (path, lineno))
            if "\t" in value:
                sys.exit("error: %s:%d value contains a tab" % (path, lineno))
            if key in seen:
                sys.exit(
                    "error: %s duplicates key %r (lines %d and %d)"
                    % (path, key, seen[key], lineno)
                )
            seen[key] = lineno
            entries.append((key, value))
    return entries


def build(config_dir, dict_dir):
    name, groups = chain_from_config(config_dir, dict_dir)
    out = []
    out.append("# OpenCC %s conversion table -- GENERATED, DO NOT EDIT BY HAND." % CONFIG)
    out.append("# Regenerate with: python3 scripts/gen-opencc-s2twp.py")
    out.append("#")
    out.append("# %s" % name)
    out.append("#")
    out.append("# Format")
    out.append("#   @group                 starts a conversion stage")
    out.append("#   @dict <name> <sha256>  starts a dictionary inside the current stage")
    out.append("#   KEY<TAB>VALUE          one entry; VALUE may hold space-separated")
    out.append("#                          alternatives, of which the first is the default")
    out.append("#   # ...                  comment; blank lines are ignored")
    out.append("#")
    out.append("# Stages apply in order.  Inside a stage, the first dictionary that")
    out.append("# matches a prefix wins -- so phrases beat single characters.")
    out.append("#")
    out.append("# Source: opencc-python-reimplemented %s, which vendors the" % package_version())
    out.append("#         dictionaries from https://github.com/BYVoid/OpenCC (Apache-2.0).")
    out.append("#         See LICENSE-opencc in this directory.")
    out.append("#")

    total = 0
    for files in groups:
        for path in files:
            total += len(read_dict(path))
    out.append("# Entries: %d across %d stages." % (total, len(groups)))
    out.append("")

    for files in groups:
        out.append("@group")
        for path in files:
            base = os.path.basename(path)
            out.append("@dict %s %s" % (base, sha256_file(path)))
            for key, value in read_dict(path):
                out.append("%s\t%s" % (key, value))
    out.append("")
    return "\n".join(out)


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--check",
        action="store_true",
        help="compare against the committed file and exit non-zero on drift; writes nothing",
    )
    args = ap.parse_args()

    _, config_dir, dict_dir = opencc_paths()
    generated = build(config_dir, dict_dir)
    out_path = os.path.join(repo_root(), OUT_REL)

    if args.check:
        if not os.path.exists(out_path):
            sys.exit("error: %s does not exist" % OUT_REL)
        with io.open(out_path, encoding="utf-8") as f:
            current = f.read()
        if current != generated:
            sys.exit(
                "error: %s is out of date -- re-run without --check.\n"
                "       committed %d bytes, generated %d bytes"
                % (OUT_REL, len(current.encode("utf-8")), len(generated.encode("utf-8")))
            )
        print("ok: %s matches the generator" % OUT_REL)
        return

    with io.open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(generated)
    print("wrote %s (%d bytes)" % (OUT_REL, len(generated.encode("utf-8"))))
    print("")
    print("Provenance block for go-api/data/hant/README.md:")
    print("")
    print("| `opencc-s2twp.txt` | opencc-python-reimplemented %s | Apache-2.0 |" % package_version())
    for name in ("STPhrases.txt", "STCharacters.txt", "TWPhrases.txt", "TWVariants.txt"):
        print("|   %s | `%s` |" % (name, sha256_file(os.path.join(dict_dir, name))))


if __name__ == "__main__":
    main()
