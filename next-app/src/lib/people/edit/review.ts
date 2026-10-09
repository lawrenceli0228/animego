// The admin's review of submitted edits (/admin/edits): the wire shapes of
// go-api's /api/admin/edits endpoints (internal/edits/review.go) and the
// pure decisions behind the review panel.

import type { EntityName, PeopleWork } from "@/lib/people/types";

export type EditKind = "character" | "person";

/** The page as its submitter saw it. */
export interface EditSnapshot {
  name: EntityName;
  image: string | null;
  work: PeopleWork | null;
}

export interface EditSubmitter {
  username: string;
  /** This submission is their nth. */
  nth: number;
  /** How many of their submissions had something accepted. */
  accepted: number;
}

export interface EditListItem {
  id: string;
  kind: EditKind;
  entityId: number;
  snapshot: EditSnapshot;
  status: "pending" | "reviewed";
  itemCount: number;
  acceptedCount: number;
  rejectedCount: number;
  hasImage: boolean;
  submitter: EditSubmitter;
  createdAt: string;
  reviewedAt: string | null;
}

export interface EditList {
  items: EditListItem[];
  hasMore: boolean;
  nextPage: number | null;
  pendingCount: number;
}

export type EditField =
  | "nameCn"
  | "nameNative"
  | "nameFull"
  | "aliases"
  | "occupations"
  | "image"
  | "gender"
  | "age"
  | "birth"
  | "bloodType"
  | "homeTown"
  | "description"
  | "voice"
  | "role";

export interface EditItem {
  id: string;
  field: EditField;
  key: string;
  old: unknown;
  new: unknown;
  meta: { work?: PeopleWork } | null;
  status: "pending" | "accepted" | "rejected";
  rejectNote: string | null;
  /** The proposed photo: admin-only while pending, public once accepted. */
  previewUrl: string | null;
  /**
   * Pending, and the page no longer shows the value it was made against:
   * another edit was accepted meanwhile. It can only be rejected.
   */
  stale: boolean;
}

/** go-api's answer when an accepted item turned out stale (internal/edits/review.go). */
export const STALE_MESSAGE = "Some changes no longer match the page";

export interface EditSubmission extends Omit<EditListItem, "hasImage"> {
  sourceUrl: string;
  note: string | null;
  reviewer: string | null;
  items: EditItem[];
}

/** A voice row's value, old or new. */
export interface VoiceValue {
  personId: number;
  name: EntityName;
  image: string | null;
  language: string | null;
  roleNotes: string | null;
  line: string | null;
}

/** A proposed photo as the item stores it. */
export interface ImageValue {
  file: string;
  width: number;
  height: number;
  source: string | null;
}

/** The dictionary key naming a field in the review. */
export function fieldLabelKey(field: EditField): string {
  return `editReview.field${field.charAt(0).toUpperCase()}${field.slice(1)}`;
}

/** Every field the review can name, for the dictionary test. */
export const EDIT_FIELDS: readonly EditField[] = [
  "nameCn", "nameNative", "nameFull", "aliases", "occupations", "image", "gender",
  "age", "birth", "bloodType", "homeTown", "description", "voice", "role",
];

export interface Decision {
  accept: boolean;
  note: string;
}

/**
 * Where the panel starts: every item accepted with no note, but a stale one
 * rejected with the given note.
 */
export function initialDecisions(items: EditItem[], staleNote = ""): Record<string, Decision> {
  return Object.fromEntries(
    items.map((it) => [it.id, it.stale ? { accept: false, note: staleNote } : { accept: true, note: "" }]),
  );
}

/** 全部采纳: every item that can be accepted; a stale one keeps its rejection and note. */
export function acceptAllDecisions(items: EditItem[], current: Record<string, Decision>): Record<string, Decision> {
  return Object.fromEntries(
    items.map((it) => [it.id, it.stale ? { accept: false, note: current[it.id]?.note ?? "" } : { accept: true, note: "" }]),
  );
}

/**
 * The panel's React key. The decisions are the panel's own state, so a
 * reload that finds an item newly stale has to start the panel again.
 */
export function panelKey(s: Pick<EditSubmission, "id" | "status" | "items">): string {
  return `${s.id}:${s.status}:${s.items.filter((it) => it.stale).map((it) => it.id).join(",")}`;
}

/** Whether every rejected item has a note, so the review can be sent. */
export function decisionsComplete(items: EditItem[], decisions: Record<string, Decision>): boolean {
  return items.every((it) => {
    const d = decisions[it.id];
    return d !== undefined && (d.accept || d.note.trim().length > 0);
  });
}

/** The body of POST /api/admin/edits/{id}/review. */
export function reviewBody(items: EditItem[], decisions: Record<string, Decision>) {
  return {
    decisions: items.map((it) => {
      const d = decisions[it.id] ?? { accept: true, note: "" };
      return d.accept ? { itemId: it.id, accept: true } : { itemId: it.id, accept: false, note: d.note.trim() };
    }),
  };
}

/** Validates a review the panel sends, on the server, before it is forwarded. */
export function validReviewBody(body: unknown): body is ReturnType<typeof reviewBody> {
  if (!body || typeof body !== "object") return false;
  const decisions = (body as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions) || decisions.length === 0 || decisions.length > 50) return false;
  return decisions.every((d) => {
    if (!d || typeof d !== "object") return false;
    const { itemId, accept, note } = d as { itemId?: unknown; accept?: unknown; note?: unknown };
    if (typeof itemId !== "string" || !UUID.test(itemId) || typeof accept !== "boolean") return false;
    if (accept) return note === undefined;
    return typeof note === "string" && note.trim().length > 0 && note.length <= 500;
  });
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
