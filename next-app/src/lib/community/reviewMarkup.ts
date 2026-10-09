// The review body's markup: the four things the write page's toolbar inserts,
// and nothing else.
//
//   **加粗**              bold
//   > 引用               a quoted line (consecutive quoted lines are one quote)
//   ~!剧透!~             a spoiler, hidden until the reader asks — AniList's
//                       syntax, which the toolbar's 剧透块 button writes
//   [文字](https://…)    a link, http and https only
//
// A blank line starts a new paragraph; a single line break stays a line
// break. Anything that does not close — a lone ** or ~! — is plain text.
//
// The result is a tree of plain data that ReviewBody renders as React
// elements. Nothing here produces HTML, so user text is never interpreted as
// markup by the browser: React escapes every text node. That is the whole
// security model, and it is why this is a parser and not a regex substitution
// into dangerouslySetInnerHTML.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "break" }
  | { kind: "bold"; children: Inline[] }
  | { kind: "spoiler"; children: Inline[] }
  | { kind: "link"; href: string; text: string };

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "quote"; children: Inline[] };

export const SPOILER_OPEN = "~!";
export const SPOILER_CLOSE = "!~";
export const BOLD = "**";

const LINK = /^\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/;

/** A link target the page may render: absolute http(s), nothing else. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

interface InlineContext {
  inBold: boolean;
  inSpoiler: boolean;
}

function pushText(out: Inline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === "text") {
    out[out.length - 1] = { kind: "text", text: last.text + text };
  } else {
    out.push({ kind: "text", text });
  }
}

/** Inline markup inside one block. Unclosed markers stay literal. */
export function parseInline(source: string, ctx: InlineContext = { inBold: false, inSpoiler: false }): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    if (!ctx.inSpoiler && rest.startsWith(SPOILER_OPEN)) {
      const end = source.indexOf(SPOILER_CLOSE, i + SPOILER_OPEN.length);
      if (end > i + SPOILER_OPEN.length) {
        const inner = source.slice(i + SPOILER_OPEN.length, end);
        out.push({ kind: "spoiler", children: parseInline(inner, { ...ctx, inSpoiler: true }) });
        i = end + SPOILER_CLOSE.length;
        continue;
      }
    }
    if (!ctx.inBold && rest.startsWith(BOLD)) {
      const end = source.indexOf(BOLD, i + BOLD.length);
      if (end > i + BOLD.length) {
        const inner = source.slice(i + BOLD.length, end);
        out.push({ kind: "bold", children: parseInline(inner, { ...ctx, inBold: true }) });
        i = end + BOLD.length;
        continue;
      }
    }
    if (rest.startsWith("[")) {
      const m = LINK.exec(rest);
      const href = m ? safeHref(m[2]) : null;
      if (m && href) {
        out.push({ kind: "link", href, text: m[1] });
        i += m[0].length;
        continue;
      }
    }
    if (source[i] === "\n") {
      out.push({ kind: "break" });
      i += 1;
      continue;
    }
    // Plain text up to the next character that could start something.
    let j = i + 1;
    while (j < source.length && !"~*[\n".includes(source[j])) j += 1;
    pushText(out, source.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * Split on blank lines, but never inside a spoiler: a spoiler the reader
 * opens may run across paragraphs, and cutting it at a blank line would leave
 * both halves unclosed — printed as literal ~! and !~, with the hidden part
 * shown.
 */
function splitBlocks(source: string): string[] {
  const blocks: string[] = [];
  let start = 0;
  let inSpoiler = false;
  let i = 0;
  while (i < source.length) {
    if (!inSpoiler && source.startsWith(SPOILER_OPEN, i) && source.indexOf(SPOILER_CLOSE, i + 2) > i + 2) {
      inSpoiler = true;
      i += 2;
      continue;
    }
    if (inSpoiler && source.startsWith(SPOILER_CLOSE, i)) {
      inSpoiler = false;
      i += 2;
      continue;
    }
    if (!inSpoiler && source[i] === "\n") {
      let j = i;
      while (j < source.length && (source[j] === "\n" || source[j] === " " || source[j] === "\t")) j += 1;
      const newlines = source.slice(i, j).split("\n").length - 1;
      if (newlines >= 2) {
        blocks.push(source.slice(start, i));
        start = j;
        i = j;
        continue;
      }
    }
    i += 1;
  }
  blocks.push(source.slice(start));
  return blocks.map((b) => b.trim()).filter((b) => b.length > 0);
}

const QUOTE_LINE = /^>\s?/;

/** The whole body, as blocks. */
export function parseReview(source: string): Block[] {
  const text = source.replace(/\r\n?/g, "\n");
  return splitBlocks(text).map((block): Block => {
    const lines = block.split("\n");
    if (lines.every((line) => QUOTE_LINE.test(line))) {
      return { kind: "quote", children: parseInline(lines.map((line) => line.replace(QUOTE_LINE, "")).join("\n")) };
    }
    return { kind: "paragraph", children: parseInline(block) };
  });
}

/** The text a reader sees with every spoiler closed — for excerpts and meta. */
export function plainText(blocks: Block[], spoilerMark = "▇▇"): string {
  const inline = (nodes: Inline[]): string =>
    nodes
      .map((node) => {
        switch (node.kind) {
          case "text":
            return node.text;
          case "break":
            return " ";
          case "bold":
            return inline(node.children);
          case "spoiler":
            return spoilerMark;
          case "link":
            return node.text;
        }
      })
      .join("");
  return blocks.map((block) => inline(block.children)).join(" ").replace(/\s+/g, " ").trim();
}

// ── the toolbar ──────────────────────────────────────────────────────────

export interface Edit {
  text: string;
  /** Where the selection should land afterwards. */
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Wrap the selection in a pair of markers; with nothing selected, insert the
 * pair with `placeholder` selected between them so the writer can type over it.
 */
export function wrapSelection(
  text: string,
  start: number,
  end: number,
  open: string,
  close: string,
  placeholder: string,
): Edit {
  const selected = text.slice(start, end) || placeholder;
  const next = text.slice(0, start) + open + selected + close + text.slice(end);
  const innerStart = start + open.length;
  return { text: next, selectionStart: innerStart, selectionEnd: innerStart + selected.length };
}

/** Prefix every line the selection touches with "> ". */
export function quoteSelection(text: string, start: number, end: number, placeholder: string): Edit {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndIdx = text.indexOf("\n", end);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const region = text.slice(lineStart, lineEnd) || placeholder;
  const quoted = region
    .split("\n")
    .map((line) => (QUOTE_LINE.test(line) ? line : `> ${line}`))
    .join("\n");
  const next = text.slice(0, lineStart) + quoted + text.slice(lineEnd);
  return { text: next, selectionStart: lineStart, selectionEnd: lineStart + quoted.length };
}

/** Turn the selection into the text of a link to `href`. */
export function linkSelection(text: string, start: number, end: number, href: string, placeholder: string): Edit {
  const label = (text.slice(start, end) || placeholder).replace(/[[\]\n]/g, " ").trim() || placeholder;
  const markup = `[${label}](${href})`;
  const next = text.slice(0, start) + markup + text.slice(end);
  return { text: next, selectionStart: start + 1, selectionEnd: start + 1 + label.length };
}
