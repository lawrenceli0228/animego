import { describe, expect, test } from "bun:test";
import {
  canEndOthers,
  otherSessions,
  parseSessionList,
  remainingSessions,
  toDeviceSessions,
  type ApiSession,
} from "./deviceSessions";

const MAC = {
  id: "8d1f6a52-3c1e-4a8e-9a57-6c1c2f1f0a01",
  current: true,
  kind: "laptop",
  os: "Mac",
  browser: "Chrome",
  city: "Shanghai",
  country: "CN",
  lastUsedAt: "2026-10-22T08:30:00Z",
  createdAt: "2026-10-21T15:09:00Z",
};

const PHONE = {
  id: "0b6e2f8c-7a44-4c3a-b2b1-1f9d6a3e5c02",
  current: false,
  kind: "phone",
  os: "iPhone",
  browser: "Safari",
  city: null,
  country: "JP",
  lastUsedAt: "2026-10-22T06:30:00Z",
  createdAt: "2026-10-20T01:00:00Z",
};

describe("parseSessionList", () => {
  test("reads the documented shape, in the server's order", () => {
    const list = parseSessionList({ items: [MAC, PHONE] });
    expect(list).toEqual([MAC, PHONE] as ApiSession[]);
  });

  test("returns nothing for a body that is not the documented shape", () => {
    expect(parseSessionList(null)).toEqual([]);
    expect(parseSessionList(undefined)).toEqual([]);
    expect(parseSessionList([])).toEqual([]);
    expect(parseSessionList({})).toEqual([]);
    expect(parseSessionList({ items: "nope" })).toEqual([]);
  });

  test("drops items it could not sign out", () => {
    const list = parseSessionList({ items: [{ ...PHONE, id: "" }, { ...PHONE, id: 7 }, null, "x", MAC] });
    expect(list.map((s) => s.id)).toEqual([MAC.id]);
  });

  test("normalises the fields it does not trust", () => {
    const [s] = parseSessionList({
      items: [{ id: " abc ", current: "true", kind: "fridge", os: 3, browser: null, city: "  ", country: "", lastUsedAt: 1 }],
    });
    expect(s).toEqual({
      id: "abc",
      current: false,
      kind: "unknown",
      os: "",
      browser: "",
      city: null,
      country: null,
      lastUsedAt: "",
      createdAt: "",
    });
  });

  test("keeps every kind the contract names", () => {
    for (const kind of ["laptop", "desktop", "phone", "tablet", "unknown"]) {
      expect(parseSessionList({ items: [{ ...PHONE, kind }] })[0]?.kind).toBe(kind as ApiSession["kind"]);
    }
  });
});

describe("toDeviceSessions", () => {
  test("replaces the city and country with one place, in the reader's language", () => {
    const [mac, phone] = toDeviceSessions(parseSessionList({ items: [MAC, PHONE] }), "zh");
    expect(mac).toEqual({
      id: MAC.id,
      current: true,
      kind: "laptop",
      os: "Mac",
      browser: "Chrome",
      place: "Shanghai",
      lastUsedAt: MAC.lastUsedAt,
      createdAt: MAC.createdAt,
    });
    expect(phone?.place).toBe("日本");
    expect(phone).not.toHaveProperty("city");
    expect(phone).not.toHaveProperty("country");
  });
});

describe("remainingSessions / otherSessions / canEndOthers", () => {
  const sessions = toDeviceSessions(parseSessionList({ items: [MAC, PHONE, { ...PHONE, id: "c3" }] }), "en");

  test("hides what this page signed out, and nothing else", () => {
    expect(remainingSessions(sessions, new Set([PHONE.id])).map((s) => s.id)).toEqual([MAC.id, "c3"]);
    expect(remainingSessions(sessions, new Set())).toEqual(sessions);
  });

  test("the others are every session but this browser's own", () => {
    expect(otherSessions(sessions).map((s) => s.id)).toEqual([PHONE.id, "c3"]);
  });

  test("offers ending the others only when there are some and this one is known", () => {
    expect(canEndOthers(sessions)).toBe(true);
    expect(canEndOthers(sessions.slice(0, 1))).toBe(false);
    expect(canEndOthers(sessions.map((s) => ({ ...s, current: false })))).toBe(false);
    expect(canEndOthers([])).toBe(false);
  });
});
