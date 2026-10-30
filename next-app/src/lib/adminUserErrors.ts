// What the user drawer and the create form say when an admin user action did
// not go through, as dictionary keys.
//
// The page runs in three languages and go-api answers in English, so nothing
// a failure carries is ever shown as it is. The actions return go-api's
// status, code and message (admin/_actions/_shared.ts UserActionFailure);
// this picks a key from them, and anything it does not recognise falls back
// to the action's own "… failed".
//
// Read off go-api/internal/admin/users.go and user_sessions.go. One status
// can mean two things there — 409 is the username or the email, 400 deleting
// yourself or a malformed id, 404 the account or (for one device) the
// session — so the message, one of go-api's fixed English constants, decides
// first. A status decides only where it means one thing for the action at
// hand: 401 and 403 come from the auth middleware in front of every route.

export type UserAction = "create" | "update" | "password" | "delete" | "revokeAll" | "revokeOne";

/** The parts of a failure this reads; a thrown action has neither status nor message. */
export interface UserActionFailureLike {
  status: number;
  message?: string;
}

/** go-api's messages (msgUsernameConflict and the rest), word for word. */
const MESSAGE_KEYS: Readonly<Record<string, string>> = {
  "Username already exists": "admin.userPanel.errUsernameTaken",
  "Email already exists": "admin.userPanel.errEmailTaken",
  "Cannot delete yourself": "admin.userPanel.errSelfDelete",
  "Cannot sign yourself out here": "admin.userPanel.errSelfRevoke",
  "User not found": "admin.userPanel.detailMissing",
  "Session not found": "admin.userPanel.errSessionGone",
};

const FALLBACK_KEYS: Readonly<Record<UserAction, string>> = {
  create: "admin.createFailed",
  update: "admin.updateFailed",
  password: "admin.passwordChangeFailed",
  delete: "admin.deleteFailed",
  revokeAll: "admin.userPanel.revokeFailed",
  revokeOne: "admin.userPanel.revokeFailed",
};

/** Actions whose only 404 is the account itself being gone. */
const ACCOUNT_404: ReadonlySet<UserAction> = new Set(["update", "password", "delete", "revokeAll"]);

/** The dictionary key for a failed action; never the failure's own text. */
export function userActionErrorKey(action: UserAction, failure: UserActionFailureLike): string {
  const { status, message } = failure;
  if (message && Object.prototype.hasOwnProperty.call(MESSAGE_KEYS, message)) return MESSAGE_KEYS[message];
  if (status === 401) return "admin.userPanel.errSignedOut";
  if (status === 403) return "admin.userPanel.errForbidden";
  if (status === 404 && ACCOUNT_404.has(action)) return "admin.userPanel.detailMissing";
  return FALLBACK_KEYS[action];
}

/** Every key userActionErrorKey can answer, for the dictionary test. */
export const USER_ACTION_ERROR_KEYS: readonly string[] = [
  ...new Set([
    ...Object.values(MESSAGE_KEYS),
    ...Object.values(FALLBACK_KEYS),
    "admin.userPanel.errSignedOut",
    "admin.userPanel.errForbidden",
  ]),
];
