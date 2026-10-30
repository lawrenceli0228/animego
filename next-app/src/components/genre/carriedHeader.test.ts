import { afterEach, describe, expect, test } from "bun:test";

import { carryHeader, dropCarriedHeader, isHeaderCarried } from "./carriedHeader";

// The header a page drew for the view on its way is handed to the page that
// lands there — that page and no other.

afterEach(() => dropCarriedHeader());

describe("the carried header", () => {
  test("nothing is carried until a link in the page is followed", () => {
    expect(isHeaderCarried({ kind: "hub", genre: "Action" })).toBe(false);
  });

  test("the genre pressed in the strip: that genre's hub keeps it, another genre's does not", () => {
    carryHeader({ kind: "hub", genre: "Fantasy" });
    expect(isHeaderCarried({ kind: "hub", genre: "Fantasy" })).toBe(true);
    expect(isHeaderCarried({ kind: "hub", genre: "Action" })).toBe(false);
    expect(isHeaderCarried({ kind: "grid", genre: "Fantasy", view: { kind: "list", list: "popular" } })).toBe(false);
  });

  test("a grid opened by 查看全部: that slice of that genre keeps it, and only that one", () => {
    carryHeader({ kind: "grid", genre: "Action", view: { kind: "list", list: "airing" } });
    expect(isHeaderCarried({ kind: "grid", genre: "Action", view: { kind: "list", list: "airing" } })).toBe(true);
    expect(isHeaderCarried({ kind: "grid", genre: "Action", view: { kind: "list", list: "top" } })).toBe(false);
    expect(isHeaderCarried({ kind: "grid", genre: "Comedy", view: { kind: "list", list: "airing" } })).toBe(false);
    expect(isHeaderCarried({ kind: "hub", genre: "Action" })).toBe(false);
  });

  test("tiles: a decade and a pairing are slices of their own", () => {
    carryHeader({ kind: "grid", genre: "Action", view: { kind: "decade", decade: "1990" } });
    expect(isHeaderCarried({ kind: "grid", genre: "Action", view: { kind: "decade", decade: "1990" } })).toBe(true);
    expect(isHeaderCarried({ kind: "grid", genre: "Action", view: { kind: "decade", decade: "2000" } })).toBe(false);

    carryHeader({ kind: "grid", genre: "Action", view: { kind: "with", with: "Fantasy" } });
    expect(isHeaderCarried({ kind: "grid", genre: "Action", view: { kind: "with", with: "Fantasy" } })).toBe(true);
    expect(isHeaderCarried({ kind: "grid", genre: "Action", view: { kind: "decade", decade: "1990" } })).toBe(false);
  });

  test("the latest link followed is the one carried", () => {
    carryHeader({ kind: "hub", genre: "Fantasy" });
    carryHeader({ kind: "hub", genre: "Comedy" });
    expect(isHeaderCarried({ kind: "hub", genre: "Fantasy" })).toBe(false);
    expect(isHeaderCarried({ kind: "hub", genre: "Comedy" })).toBe(true);
  });

  test("once dropped — the page landed, or the reader went Back — no page keeps it", () => {
    carryHeader({ kind: "hub", genre: "Fantasy" });
    dropCarriedHeader();
    expect(isHeaderCarried({ kind: "hub", genre: "Fantasy" })).toBe(false);
  });
});
