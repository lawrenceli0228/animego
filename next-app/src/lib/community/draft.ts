// The write page's 存草稿: a draft kept in this browser only.
//
// localStorage on purpose. A draft is one reader's unfinished text on one
// device; nobody else needs it and nothing breaks without it. Every access is
// guarded — storage can be absent (private windows, blocked site data) or
// throw, and the page has to work the same either way.
//
// Keyed by reader as well as anime: on a shared browser the next account to
// open the write page must not be handed someone else's draft, which may be
// one they meant to keep private.

export interface ReviewDraft {
  summary: string;
  body: string;
  isSpoiler: boolean;
  isPrivate: boolean;
  savedAt: string;
}

const PREFIX = "agc:review-draft:";

function key(userId: string, anilistId: number): string {
  return `${PREFIX}${userId}:${anilistId}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadDraft(userId: string, anilistId: number): ReviewDraft | null {
  try {
    const raw = storage()?.getItem(key(userId, anilistId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ReviewDraft> | null;
    if (!value || typeof value !== "object") return null;
    return {
      summary: typeof value.summary === "string" ? value.summary : "",
      body: typeof value.body === "string" ? value.body : "",
      isSpoiler: value.isSpoiler === true,
      isPrivate: value.isPrivate === true,
      savedAt: typeof value.savedAt === "string" ? value.savedAt : "",
    };
  } catch {
    return null;
  }
}

export function saveDraft(userId: string, anilistId: number, draft: Omit<ReviewDraft, "savedAt">): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(key(userId, anilistId), JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(userId: string, anilistId: number): void {
  try {
    storage()?.removeItem(key(userId, anilistId));
  } catch {
    /* nothing to clear */
  }
}
