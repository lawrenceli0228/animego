import { describe, expect, test } from "bun:test";

import type { Character, Person } from "@/lib/people/types";
import {
  birthValue,
  bloodTypeOptions,
  characterDraft,
  diffDraft,
  genderOptions,
  personDraft,
  personIdFromInput,
  submissionBody,
  validSource,
  voiceLineChange,
  type CharacterDraft,
  type PersonDraft,
} from "./model";

const STARK: Character = {
  anilistId: 184313,
  bangumiId: 89182,
  name: { full: "Stark", native: "シュタルク", cn: "修塔尔克" },
  alternativeNames: ["休塔尔克"],
  image: "https://s4.anilist.co/file/anilistcdn/character/large/b184313.jpg",
  profile: { description: "A warrior.", gender: "Male", age: null, birth: null, bloodType: null, siteUrl: null },
  voices: [
    {
      key: "133507|Japanese|",
      person: { anilistId: 133507, name: { full: "Chiaki Kobayashi", native: "小林千晃", cn: "小林千晃" }, image: null },
      language: "Japanese",
      roleNotes: null,
      line: null,
    },
    {
      key: "115100|Japanese|Childhood",
      person: { anilistId: 115100, name: { full: "Child", native: null, cn: null }, image: null },
      language: "Japanese",
      roleNotes: "Childhood",
      line: null,
    },
  ],
  appearances: [
    { anime: { anilistId: 154587 } as Character["appearances"][number]["anime"], role: "MAIN" },
    { anime: { anilistId: 182255 } as Character["appearances"][number]["anime"], role: "MAIN" },
  ],
  indexable: true,
};

const KOBAYASHI: Person = {
  anilistId: 133507,
  bangumiId: 32265,
  name: { full: "Chiaki Kobayashi", native: "小林千晃", cn: "小林千晃" },
  image: null,
  profile: {
    occupations: ["Voice Actor"],
    gender: "Male",
    birth: { year: 1994, month: 6, day: 4 },
    death: null,
    age: 32,
    yearsActive: [],
    homeTown: "Kanagawa Prefecture, Japan",
    bloodType: null,
    language: "Japanese",
    siteUrl: null,
  },
  representativeRoles: [],
  voiceRoles: [],
  staffRoles: [],
  voiceWorkCount: 0,
  staffWorkCount: 0,
  indexable: false,
};

function edit<T extends object>(draft: T, patch: Partial<T>): T {
  return { ...draft, ...patch };
}

describe("drafts open as the page shows itself", () => {
  test("a character, its voice lines in the reader's language", () => {
    const d = characterDraft(STARK, "zh");
    expect(d.nameCn).toBe("修塔尔克");
    expect(d.aliases).toEqual(["休塔尔克"]);
    expect(d.voices.map((v) => v.line)).toEqual(["日配", "日配 · 童年"]);
    expect(d.voices.map((v) => v.autoLine)).toEqual([true, true]);
    expect(d.roles).toEqual({ 154587: "MAIN", 182255: "MAIN" });
    expect(diffDraft(d, d)).toEqual({ changes: {}, count: 0, invalid: false });
  });

  test("an edited voice line is shown as written", () => {
    const withLine = { ...STARK, voices: [{ ...STARK.voices[0], line: "日配 · 主役" }] };
    expect(characterDraft(withLine, "zh").voices[0].line).toBe("日配 · 主役");
    expect(characterDraft(withLine, "zh").voices[0].autoLine).toBe(false);
  });

  test("a person, the home town and occupations translated", () => {
    const d = personDraft(KOBAYASHI, "zh");
    expect(d.homeTown).toBe("神奈川县");
    expect(d.occupations).toEqual([{ value: "Voice Actor", label: "声优" }]);
    expect(d.birthYear).toBe("1994");
    expect(diffDraft(d, d).count).toBe(0);
  });
});

describe("the diff", () => {
  test("names, facts and the photo, with clearing", () => {
    const start = characterDraft(STARK, "zh");
    const now = edit(start, {
      nameCn: " 史塔克 ",
      gender: "",
      age: "17",
      birthMonth: "3",
      birthDay: "2",
      description: "  A warrior.  ",
      photo: { kind: "url", url: " https://example.org/stark.png " },
    });
    const { changes, count, invalid } = diffDraft(start, now);
    expect(invalid).toBe(false);
    expect(changes).toEqual({
      nameCn: "史塔克",
      image: { url: "https://example.org/stark.png" },
      gender: null,
      birth: { year: null, month: 3, day: 2 },
      age: "17",
    });
    expect(count).toBe(5);
  });

  test("a birthday the page has is checked only once it is changed", () => {
    // The data can hold dates the editor would refuse (30 February); a draft
    // that leaves the birthday alone is still sent.
    const odd = characterDraft({ ...STARK, profile: { ...STARK.profile!, birth: { year: null, month: 2, day: 30 } } }, "zh");
    expect(diffDraft(odd, edit(odd, { nameCn: "史塔克" }))).toEqual({ changes: { nameCn: "史塔克" }, count: 1, invalid: false });
    expect(diffDraft(odd, edit(odd, { birthDay: "31" })).invalid).toBe(true);
    expect(diffDraft(odd, edit(odd, { birthDay: "28" })).changes.birth).toEqual({ year: null, month: 2, day: 28 });
  });

  test("a character is born in any year its story sets; a person not after next year", () => {
    const future = characterDraft({ ...STARK, profile: { ...STARK.profile!, birth: { year: 2199, month: 4, day: 1 } } }, "zh");
    expect(future.birthYear).toBe("2199");
    expect(diffDraft(future, edit(future, { birthDay: "2" })).changes.birth).toEqual({ year: 2199, month: 4, day: 2 });
    const person = personDraft(KOBAYASHI, "zh");
    expect(diffDraft(person, edit(person, { birthYear: "2199" })).invalid).toBe(true);
  });

  test("emptying a name, or a date that cannot be, blocks the submission", () => {
    const start = characterDraft(STARK, "zh");
    expect(diffDraft(start, edit(start, { nameNative: "  " })).invalid).toBe(true);
    expect(diffDraft(start, edit(start, { birthMonth: "2", birthDay: "30" })).invalid).toBe(true);
    expect(diffDraft(start, edit(start, { birthDay: "3" })).invalid).toBe(true);
    expect(diffDraft(start, edit(start, { birthYear: "19x4" })).invalid).toBe(true);
  });

  test("aliases as a list, blanks and repeats ignored", () => {
    const start = characterDraft(STARK, "zh");
    expect(diffDraft(start, edit(start, { aliases: ["休塔尔克", " ", "休塔尔克"] })).count).toBe(0);
    const { changes, count } = diffDraft(start, edit(start, { aliases: ["休塔尔克", "史塔克"] }));
    expect(changes.aliases).toEqual(["休塔尔克", "史塔克"]);
    expect(count).toBe(1);
  });

  test("voice rows: a new line, given to someone else, removed, added", () => {
    const start = characterDraft(STARK, "zh");
    const someone = { anilistId: 95185, name: { full: "Someone", native: null, cn: "某人" }, image: null };
    const now: CharacterDraft = {
      ...start,
      voices: [
        { ...start.voices[0], line: "日配 · 主役" },
        { ...start.voices[1], person: someone },
        { key: null, person: { ...someone, anilistId: 777 }, initialPersonId: null, line: "中配", initialLine: "", autoLine: false, removed: false },
        { key: null, person: { ...someone, anilistId: 888 }, initialPersonId: null, line: "", initialLine: "", autoLine: false, removed: true },
      ],
    };
    const { changes, count } = diffDraft(start, now);
    expect(changes.voices).toEqual([
      { key: "133507|Japanese|", line: "日配 · 主役" },
      { key: "115100|Japanese|Childhood", personId: 95185 },
      { personId: 777, line: "中配" },
    ]);
    expect(count).toBe(3);

    const removed = { ...start, voices: [{ ...start.voices[0], removed: true }, start.voices[1]] };
    expect(diffDraft(start, removed).changes.voices).toEqual([{ key: "133507|Japanese|", remove: true }]);

    // The line the page makes from the credit (日配), emptied, is still that
    // line: the page shows it whenever none is written. Nothing to send.
    const cleared = { ...start, voices: [{ ...start.voices[0], line: "  " }, start.voices[1]] };
    expect(diffDraft(start, cleared)).toEqual({ changes: {}, count: 0, invalid: false });
    expect(voiceLineChange(cleared.voices[0])).toBeUndefined();
    // A written line emptied goes back to the credit's.
    const written = characterDraft({ ...STARK, voices: [{ ...STARK.voices[0], line: "日配 · 主役" }] }, "zh");
    const unwritten = { ...written, voices: [{ ...written.voices[0], line: "" }] };
    expect(diffDraft(written, unwritten).changes.voices).toEqual([{ key: "133507|Japanese|", line: null }]);
    expect(voiceLineChange(unwritten.voices[0])).toBeNull();
  });

  test("roles per title", () => {
    const start = characterDraft(STARK, "zh");
    const { changes, count } = diffDraft(start, { ...start, roles: { 154587: "MAIN", 182255: "SUPPORTING" } });
    expect(changes.roles).toEqual([{ animeId: 182255, role: "SUPPORTING" }]);
    expect(count).toBe(1);
  });

  test("a person's occupations and home town", () => {
    const start = personDraft(KOBAYASHI, "zh");
    const now: PersonDraft = {
      ...start,
      occupations: [...start.occupations, { value: "歌手", label: "歌手" }],
      homeTown: "东京都",
    };
    const { changes, count } = diffDraft(start, now);
    expect(changes).toEqual({ occupations: ["Voice Actor", "歌手"], homeTown: "东京都" });
    expect(count).toBe(2);
  });

  test("the body: the page, the source, the note only when written", () => {
    const start = edit(characterDraft(STARK, "zh"), { sourceUrl: " https://frieren-anime.jp/ ", note: "  " });
    expect(submissionBody(start, { nameCn: "史塔克" })).toEqual({
      kind: "character",
      entityId: 184313,
      sourceUrl: "https://frieren-anime.jp/",
      changes: { nameCn: "史塔克" },
    });
    expect(submissionBody(edit(start, { note: " 官网 " }), {}).note).toBe("官网");
  });
});

describe("helpers", () => {
  test("birthValue", () => {
    expect(birthValue({ birthYear: "", birthMonth: "", birthDay: "" })).toBeNull();
    expect(birthValue({ birthYear: "", birthMonth: "2", birthDay: "29" })).toEqual({ year: null, month: 2, day: 29 });
    expect(birthValue({ birthYear: "2023", birthMonth: "2", birthDay: "29" })).toBe("bad");
    expect(birthValue({ birthYear: "1994", birthMonth: "13", birthDay: "" })).toBe("bad");
    expect(birthValue({ birthYear: "999", birthMonth: "", birthDay: "" })).toBe("bad");
    expect(birthValue({ birthYear: "2199", birthMonth: "", birthDay: "" }, "character")).toEqual({ year: 2199, month: null, day: null });
    expect(birthValue({ birthYear: "0", birthMonth: "", birthDay: "" }, "character")).toBe("bad");
  });

  test("validSource", () => {
    expect(validSource("https://frieren-anime.jp/character/")).toBe(true);
    expect(validSource("http://example.org")).toBe(true);
    for (const bad of ["", "  ", "frieren-anime.jp", "javascript:alert(1)", "ftp://x.org", "https://u:p@x.org"]) {
      expect(validSource(bad)).toBe(false);
    }
  });

  test("personIdFromInput", () => {
    expect(personIdFromInput("133507")).toBe(133507);
    expect(personIdFromInput(" https://anilist.co/staff/133507/Chiaki-Kobayashi ")).toBe(133507);
    expect(personIdFromInput("https://animegoclub.com/en/person/133507")).toBe(133507);
    expect(personIdFromInput("/person/95185?x=1")).toBe(95185);
    expect(personIdFromInput("小林千晃")).toBeNull();
    expect(personIdFromInput("0")).toBeNull();
    expect(personIdFromInput("https://anilist.co/character/184313")).toBeNull();
  });

  test("the selects keep a value outside their list", () => {
    expect(genderOptions("", "zh").map((o) => o.label)).toEqual(["男", "女", "其他"]);
    expect(genderOptions("Non-binary", "zh").map((o) => o.value)).toEqual(["Male", "Female", "Other", "Non-binary"]);
    expect(bloodTypeOptions("A+", "zh").map((o) => o.label)).toEqual(["A型", "B型", "O型", "AB型", "A+型"]);
  });
});
