// The signed-in sessions behind the 登录设备 section: what GET
// /api/auth/sessions sends, read defensively, and the shape the page hands to
// the client.
//
// Pure: no DOM, no React — page.tsx runs it on the server and the tests run
// it under bun.

import type { Lang } from "@/lib/i18n/lang";
import { placeLabel } from "./deviceLabels";

export const DEVICE_KINDS = ["laptop", "desktop", "phone", "tablet", "unknown"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** One item of GET /api/auth/sessions, after validation. */
export interface ApiSession {
  id: string;
  /** This browser's own session. False on every item when the server cannot tell. */
  current: boolean;
  kind: DeviceKind;
  os: string;
  browser: string;
  city: string | null;
  /** ISO 3166-1 alpha-2, e.g. "CN". */
  country: string | null;
  lastUsedAt: string;
  createdAt: string;
}

/** A session as the client renders it: the location already resolved to words. */
export interface DeviceSession extends Omit<ApiSession, "city" | "country"> {
  /** "Shanghai", "日本", or "" — resolved on the server, see placeLabel. */
  place: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | null {
  const s = text(value);
  return s ? s : null;
}

function deviceKind(value: unknown): DeviceKind {
  return (DEVICE_KINDS as readonly unknown[]).includes(value) ? (value as DeviceKind) : "unknown";
}

function parseSession(value: unknown): ApiSession | null {
  const item = record(value);
  const id = text(item?.id);
  if (!item || !id) return null;
  return {
    id,
    current: item.current === true,
    kind: deviceKind(item.kind),
    os: text(item.os),
    browser: text(item.browser),
    city: optionalText(item.city),
    country: optionalText(item.country),
    lastUsedAt: text(item.lastUsedAt),
    createdAt: text(item.createdAt),
  };
}

/**
 * The `data` of GET /api/auth/sessions → its items, in the server's order
 * (current first, then most recently used). An item without an id is dropped:
 * it could not be signed out, and a tile that cannot be acted on is noise.
 */
export function parseSessionList(data: unknown): ApiSession[] {
  const items = record(data)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(parseSession).filter((s): s is ApiSession => s !== null);
}

/** Resolve each session's place for `lang`. Server side — see placeLabel. */
export function toDeviceSessions(items: readonly ApiSession[], lang: Lang): DeviceSession[] {
  return items.map(({ city, country, ...rest }) => ({ ...rest, place: placeLabel(city, country, lang) }));
}

/** The sessions still standing after this page signed some out. */
export function remainingSessions<T extends { id: string }>(
  sessions: readonly T[],
  signedOut: ReadonlySet<string>,
): T[] {
  return sessions.filter((s) => !signedOut.has(s.id));
}

/** Every session other than this browser's own — what 退出其他设备 ends. */
export function otherSessions<T extends { current: boolean }>(sessions: readonly T[]): T[] {
  return sessions.filter((s) => !s.current);
}

/**
 * Whether 退出其他设备 can be offered: there are others to end, and the server
 * knows which session is this one. Without the second, DELETE
 * /api/auth/sessions answers 400, so the button would only ever fail.
 */
export function canEndOthers(sessions: readonly { current: boolean }[]): boolean {
  return sessions.some((s) => s.current) && sessions.some((s) => !s.current);
}
