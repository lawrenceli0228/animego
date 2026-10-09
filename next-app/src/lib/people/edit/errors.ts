// go-api's answers to POST /api/edits (internal/edits/submit.go), as the
// dictionary keys the edit page shows them by. The messages are go-api's
// stable English; a message this table does not know falls back by status.

const MESSAGE_KEYS: Record<string, string> = {
  "Nothing changed": "peopleEdit.errors.nothingChanged",
  "A source link is required": "peopleEdit.errors.sourceRequired",
  "The source must be an http or https link": "peopleEdit.errors.sourceInvalid",
  "The note is too long": "peopleEdit.errors.noteTooLong",
  "Too many changes in one submission": "peopleEdit.errors.tooManyChanges",
  "The image link must be a public https link": "peopleEdit.errors.imageLink",
  "The image could not be fetched": "peopleEdit.errors.imageFetch",
  "The image must be a JPEG or PNG": "peopleEdit.errors.imageType",
  "The image is too large": "peopleEdit.errors.imageTooLarge",
  "The image could not be read": "peopleEdit.errors.imageUnreadable",
  "This page already has a submission of yours waiting for review": "peopleEdit.errors.pending",
  "Too many submissions, try again later": "peopleEdit.errors.tooMany",
  "Page not found": "peopleEdit.errors.notFound",
};

/** Every key editErrorKey can answer, for the dictionary test. */
export const EDIT_ERROR_KEYS: readonly string[] = [
  ...new Set([
    ...Object.values(MESSAGE_KEYS),
    "peopleEdit.errors.invalid",
    "peopleEdit.errors.login",
    "peopleEdit.errors.failed",
  ]),
];

/** The dictionary key for a failed submission's answer. */
export function editErrorKey(status: number, message: string | null | undefined): string {
  if (message && Object.prototype.hasOwnProperty.call(MESSAGE_KEYS, message)) return MESSAGE_KEYS[message];
  if (message?.startsWith("invalid change:")) return "peopleEdit.errors.invalid";
  if (status === 401) return "peopleEdit.errors.login";
  if (status === 429) return "peopleEdit.errors.tooMany";
  return "peopleEdit.errors.failed";
}
