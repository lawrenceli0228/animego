// The settings page's pure rules: what the server's answers mean, what a
// save would send, and how the email is shown. No DOM, no React.

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** Read both legacy `{error:string}` and standard `{error:{message}}` bodies. */
export function settingsErrorMessage(
  value: unknown,
  fallback = "保存失败",
): string {
  const body = record(value);
  if (!body) return fallback;
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  const nested = record(body.error);
  if (typeof nested?.message === "string" && nested.message.trim()) {
    return nested.message;
  }
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  return fallback;
}

/** The `data` of a `{ data: … }` envelope, or null for any other body. */
export function envelopeData(value: unknown): unknown {
  const body = record(value);
  return body && "data" in body ? body.data : null;
}

const MIN_USERNAME = 3;

/** Whether the username field holds something worth a 保存: changed, and long enough. */
export function canSaveName(draft: string, saved: string): boolean {
  const name = draft.trim();
  return name.length >= MIN_USERNAME && name !== saved;
}

/**
 * Whether to say the name is too short: a change of one or two characters.
 * Not for an empty field (nothing typed yet is not a mistake) and not for the
 * saved name itself, whatever its length.
 */
export function isNameTooShort(draft: string, saved: string): boolean {
  const name = draft.trim();
  return name.length > 0 && name.length < MIN_USERNAME && name !== saved;
}

// The editors below are declared here, away from their hooks, so the sections
// that take them can be rendered in a test: the hooks load react-hot-toast,
// which bun:test cannot (testImportHygiene.test.ts follows type imports too).

/** The username field (useUsernameEditor). */
export interface UsernameEditor {
  /** The field's value, which the pass and the preview show as it is typed. */
  draft: string;
  setDraft: (value: string) => void;
  saved: string;
  /** The server shows a masked handle for this account and the field still holds it. */
  hidden: boolean;
  canSave: boolean;
  /** One or two characters typed: say so, since 保存 does not appear for them. */
  tooShort: boolean;
  /** A save is out. */
  saving: boolean;
  /** Resolves true once the server holds the new name. */
  save: () => Promise<boolean>;
}

/** The member pass as saved, or as edited on this page. */
export interface PassFields {
  /** The card photo: an /api/avatars URL once saved, a data: URL while only previewed. */
  photo: string | null;
  backdrop: number | null;
}

/** The 通行证 section's editor (usePassEditor). */
export interface PassEditor {
  /** The pass as it looks on this page: the live preview, saved or not. */
  edited: PassFields;
  /** Differs from what is saved, i.e. the save bar is up. */
  dirty: boolean;
  /** A save is out; the pass's controls hold still until it answers. */
  saving: boolean;
  setPhoto: (photo: string | null) => void;
  setBackdrop: (anilistId: number) => void;
  revert: () => void;
  /** Resolves true once the server holds the edit. */
  save: () => Promise<boolean>;
}

/**
 * The edit after a save answers, field by field: a field still as it was sent
 * takes the server's value (its /api/avatars URL replaces the data: preview
 * that went up), and a field changed again meanwhile keeps the newer edit,
 * still unsaved. Comparing the pass as a whole would keep the data: URL
 * whenever only the backdrop moved, and the next save would upload the photo
 * a second time.
 */
export function mergeSaved(current: PassFields, sent: PassFields, now: PassFields): PassFields {
  return {
    photo: current.photo === sent.photo ? now.photo : current.photo,
    backdrop: current.backdrop === sent.backdrop ? now.backdrop : current.backdrop,
  };
}

/**
 * The PATCH /api/auth/me body that saves `edited` over `saved`, or null when
 * nothing differs. A removed photo is sent as "" and a cleared backdrop as 0:
 * that is how the endpoint is told to clear them.
 */
export function passPatch(edited: PassFields, saved: PassFields): Record<string, string | number> | null {
  const photoChanged = edited.photo !== saved.photo;
  const backdropChanged = edited.backdrop !== saved.backdrop;
  if (!photoChanged && !backdropChanged) return null;
  return {
    ...(photoChanged ? { avatarUrl: edited.photo ?? "" } : {}),
    ...(backdropChanged ? { backdropAnilistId: edited.backdrop ?? 0 } : {}),
  };
}

/** The parts of PATCH /api/auth/me's answer the page keeps. */
export interface SavedAccount {
  username: string;
  usernameHidden: boolean;
  photo: string | null;
  backdrop: number | null;
}

/** `{ user: SafeUser }` from PATCH /api/auth/me → what it says is now saved; null if unreadable. */
export function readSavedAccount(data: unknown): SavedAccount | null {
  const user = record(record(data)?.user);
  if (!user || typeof user.username !== "string") return null;
  const avatar = user.avatarUrl;
  const backdrop = user.backdropAnilistId;
  return {
    username: user.username,
    usernameHidden: user.usernameHidden === true,
    photo: typeof avatar === "string" && avatar ? avatar : null,
    backdrop: typeof backdrop === "number" && backdrop > 0 ? backdrop : null,
  };
}

/** `{ revoked: n }` from the session DELETEs, or `fallback` when the count is missing. */
export function revokedCount(data: unknown, fallback: number): number {
  const n = record(data)?.revoked;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : fallback;
}

const MASK = "•••";

/**
 * "sh•••@example.com": the first two characters of the local part, or only
 * the first when the local part is one or two characters long (two would be
 * all of it), then the domain as it is. Counted in code points so a
 * character outside the BMP is never cut in half.
 */
export function maskEmail(email: string): string {
  const value = email.trim();
  const at = value.lastIndexOf("@");
  const local = Array.from(at >= 0 ? value.slice(0, at) : value);
  const domain = at >= 0 ? value.slice(at) : "";
  const shown = local.slice(0, local.length > 2 ? 2 : 1).join("");
  return `${shown}${MASK}${domain}`;
}
