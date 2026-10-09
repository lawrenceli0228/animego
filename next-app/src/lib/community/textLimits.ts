// The community tab's length limits, measured the way go-api measures them
// (internal/community/validate.go), so the counter under a field and the
// server's answer agree.
//
//   * Minimums count VISIBLE characters: every run of whitespace counts once
//     and invisible format characters (zero-width spaces, a byte-order mark,
//     \p{Cf}) not at all. "好", four hundred spaces and "好" is three.
//   * Maximums count STORED characters (code points after the server's own
//     normalisation), which is what the database CHECK sees.
//
// Code points, not UTF-16 units: Array.from, never .length. An emoji is one
// character to a reader and to Postgres's char_length, and two to .length.

export const REVIEW_SUMMARY_MIN = 10;
export const REVIEW_SUMMARY_MAX = 60;
export const REVIEW_BODY_MIN = 300;
export const REVIEW_BODY_MAX = 20000;
export const THREAD_TITLE_MIN = 4;
export const THREAD_TITLE_MAX = 80;
export const THREAD_BODY_MAX = 5000;
export const REPLY_MAX = 500;

const FORMAT_CHARS = /\p{Cf}/gu;
const WHITESPACE_RUN = /\s+/gu;
// Control characters other than \n and \t, which the server drops.
const DROPPED_CONTROLS = /[\p{Cc}]/gu;

function codePoints(s: string): number {
  return Array.from(s).length;
}

/** What go-api stores for a multi-line field: LF line endings, no stray controls, trimmed. */
export function normalizeBody(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(DROPPED_CONTROLS, (c) => (c === "\n" || c === "\t" ? c : ""))
    .trim();
}

/** What go-api stores for a one-line field: every whitespace run is one space. */
export function normalizeLine(s: string): string {
  return normalizeBody(s).replace(WHITESPACE_RUN, " ");
}

/** Characters a reader can see — what the minimums are measured in. */
export function visibleLength(s: string): number {
  return codePoints(s.replace(FORMAT_CHARS, "").trim().replace(WHITESPACE_RUN, " "));
}

/** Characters the server will store — what the maximums are measured in. */
export function storedBodyLength(s: string): number {
  return codePoints(normalizeBody(s));
}

export function storedLineLength(s: string): number {
  return codePoints(normalizeLine(s));
}

export type ReviewProblem = "summaryLength" | "bodyShort" | "bodyLong";

/** Every reason the review form cannot be sent yet, in field order. */
export function reviewProblems(summary: string, body: string): ReviewProblem[] {
  const problems: ReviewProblem[] = [];
  if (visibleLength(normalizeLine(summary)) < REVIEW_SUMMARY_MIN || storedLineLength(summary) > REVIEW_SUMMARY_MAX) {
    problems.push("summaryLength");
  }
  if (visibleLength(body) < REVIEW_BODY_MIN) problems.push("bodyShort");
  else if (storedBodyLength(body) > REVIEW_BODY_MAX) problems.push("bodyLong");
  return problems;
}

export type ThreadProblem = "titleLength" | "bodyEmpty" | "bodyLong";

export function threadProblems(title: string, body: string): ThreadProblem[] {
  const problems: ThreadProblem[] = [];
  if (visibleLength(normalizeLine(title)) < THREAD_TITLE_MIN || storedLineLength(title) > THREAD_TITLE_MAX) {
    problems.push("titleLength");
  }
  if (visibleLength(body) === 0) problems.push("bodyEmpty");
  else if (storedBodyLength(body) > THREAD_BODY_MAX) problems.push("bodyLong");
  return problems;
}

export type ReplyProblem = "empty" | "tooLong";

export function replyProblem(body: string): ReplyProblem | null {
  if (visibleLength(body) === 0) return "empty";
  if (storedBodyLength(body) > REPLY_MAX) return "tooLong";
  return null;
}
