// AniList's description markup, parsed into paragraphs the character page
// renders as React nodes. Never as HTML: nothing here produces a string for
// dangerouslySetInnerHTML, so whatever a user-edited description contains is
// text by the time it reaches the page.
//
// What AniList descriptions use, and what becomes of it:
//
//   ~!spoiler!~          a spoiler node, collapsed by the page. It may span
//                        paragraphs; every piece carries the same id so the
//                        page reveals them together. An unclosed one runs to
//                        the end — a spoiler that leaks because a closing
//                        marker is missing is the one failure not to have.
//   __x__  **x**         strong
//   _x_   *x*            em (an underscore inside a word is not emphasis)
//   [text](url)          the text. Links are not followed: most point at
//                        AniList pages, and an AniList character id is a page
//                        here only if some title we list credits it.
//   blank line / newline paragraph / line break
//   <br>, other tags     a line break / dropped
//   &amp; and friends    decoded
//   ~~~centre~~~, # heading, img220(url), ![alt](url), youtube(id)
//                        reduced to their text, or dropped

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "br" }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | {
      type: "spoiler";
      /** One id per ~!…!~; the pieces of one spoiler share it. */
      id: number;
      /** True for every piece after the first, in a later paragraph. */
      continued: boolean;
      children: InlineNode[];
    };

export interface Paragraph {
  inlines: InlineNode[];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** One level of parentheses inside a URL, as Wikipedia links need. */
const URL_BODY = String.raw`(?:[^()\s]|\([^()\s]*\))*`;

/** Everything that is not spoilers, paragraphs or emphasis, reduced to text. */
function clean(md: string): string {
  return decodeEntities(
    md
      .replace(/\r\n?/g, "\n")
      .replace(new RegExp(String.raw`!\[[^\]]*\]\(${URL_BODY}\)`, "g"), "")
      .replace(new RegExp(String.raw`\b(?:img|image)\d*%?\(${URL_BODY}\)`, "gi"), "")
      .replace(new RegExp(String.raw`\b(?:youtube|webm)\(${URL_BODY}\)`, "gi"), "")
      .replace(new RegExp(String.raw`\[([^\]]*)\]\(${URL_BODY}\)`, "g"), "$1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?[a-z][^>]*>/gi, "")
      .replace(/~~~/g, "")
      .replace(/^[ \t]*#{1,6}[ \t]*/gm, "")
      .replace(/\n[ \t]+\n/g, "\n\n"),
  );
}

interface Segment {
  text: string;
  spoiler: number | null;
}

/** Split on the spoiler markers. A stray `!~` is dropped; `~!` inside a spoiler is ignored. */
function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let current: number | null = null;
  let next = 0;
  let rest = text;
  while (rest) {
    const marker = current === null ? /~!|!~/.exec(rest) : /!~/.exec(rest);
    if (!marker) {
      out.push({ text: rest, spoiler: current });
      break;
    }
    if (marker.index > 0) out.push({ text: rest.slice(0, marker.index), spoiler: current });
    if (marker[0] === "~!") current = next++;
    else current = null;
    rest = rest.slice(marker.index + 2);
  }
  return out;
}

/** Emphasis inside one line of text. */
function emphasis(line: string): InlineNode[] {
  const pattern =
    /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*|__(?=\S)([\s\S]+?)(?<=\S)__|(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])|(?<![A-Za-z0-9_])_(?=\S)([^_]+?)(?<=\S)_(?![A-Za-z0-9_])/;
  const out: InlineNode[] = [];
  let rest = line;
  while (rest) {
    const m = pattern.exec(rest);
    if (!m) {
      out.push({ type: "text", value: rest });
      break;
    }
    if (m.index > 0) out.push({ type: "text", value: rest.slice(0, m.index) });
    const strong = m[1] ?? m[2];
    if (strong !== undefined) out.push({ type: "strong", children: emphasis(strong) });
    else out.push({ type: "em", children: emphasis(m[3] ?? m[4]) });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** A run of text with single newlines as line breaks. */
function lines(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) out.push({ type: "br" });
    if (line) out.push(...emphasis(line));
  });
  return out;
}

function hasText(nodes: InlineNode[]): boolean {
  return nodes.some((n) =>
    n.type === "text" ? n.value.trim() !== "" : n.type === "br" ? false : hasText(n.children),
  );
}

/** Trim the whitespace and line breaks at a paragraph's two edges, descending into containers. */
function trimEdge(nodes: InlineNode[], side: "start" | "end"): InlineNode[] {
  const list = side === "start" ? [...nodes] : [...nodes].reverse();
  while (list.length) {
    const n = list[0];
    if (n.type === "br") {
      list.shift();
      continue;
    }
    if (n.type === "text") {
      const value = side === "start" ? n.value.trimStart() : n.value.trimEnd();
      if (!value) {
        list.shift();
        continue;
      }
      list[0] = { type: "text", value };
      break;
    }
    const children = trimEdge(n.children, side);
    if (!hasText(children)) {
      list.shift();
      continue;
    }
    list[0] = { ...n, children };
    break;
  }
  return side === "start" ? list : list.reverse();
}

/** The paragraphs of an AniList description; [] for nothing. */
export function parseAnilistMarkdown(md: string | null | undefined): Paragraph[] {
  if (!md?.trim()) return [];
  const paragraphs: InlineNode[][] = [[]];
  const opened = new Set<number>();

  for (const seg of segments(clean(md))) {
    seg.text.split(/\n{2,}/).forEach((piece, i) => {
      if (i > 0) paragraphs.push([]);
      if (!piece) return;
      const nodes = lines(piece);
      const paragraph = paragraphs[paragraphs.length - 1];
      if (seg.spoiler === null) {
        paragraph.push(...nodes);
        return;
      }
      // A piece with nothing to read must not take the "first piece" slot:
      // the first piece is where the page puts the button, and if it were
      // trimmed away the rest of the spoiler would be hidden behind nothing.
      if (!hasText(nodes)) return;
      const continued = opened.has(seg.spoiler);
      opened.add(seg.spoiler);
      paragraph.push({ type: "spoiler", id: seg.spoiler, continued, children: nodes });
    });
  }

  return paragraphs
    .map((p) => trimEdge(trimEdge(p, "start"), "end"))
    .filter(hasText)
    .map((inlines) => ({ inlines }));
}
