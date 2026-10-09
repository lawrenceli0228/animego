import { describe, expect, test } from "bun:test";

import type { StaffCredit } from "@/lib/types";
import {
  DEPARTMENTS,
  DEPARTMENT_LABEL,
  NAMES_ONLY_FROM,
  departmentOf,
  groupStaff,
  isNamesOnly,
  searchStaff,
  staffPeopleCount,
} from "./staffDepartments";

// The 制作 tab groups a title's credits by department. AniList's roles are
// free text ("Storyboard (OP23, eps 465, 474…", "Theme Song Performance
// (Spanish; OP2)"), so the grouping is a rule list over the role with its
// trailing qualifier removed, and every role lands somewhere — the last
// department is 其他, never a dropped credit.

const credit = (staffId: number | null, role: string, nameJa = `人${staffId}`, nameEn = `Person ${staffId}`): StaffCredit => ({
  staffId,
  role,
  nameJa,
  nameEn,
  nameCn: null,
  imageUrl: null,
});

describe("departmentOf", () => {
  // Read off the roles the dev catalogue actually holds, the frequent ones
  // and the ones that look like they belong somewhere they do not.
  const cases: Array<[string, string]> = [
    ["Original Creator", "original"],
    ["Original Story", "original"],
    ["Original Character Design", "original"],
    ["Original Work Assistance", "original"],
    ["Director", "direction"],
    ["Assistant Director", "direction"],
    ["Episode Director", "direction"],
    ["Episode Director (eps 3, 7)", "direction"],
    ["Storyboard (OP23, eps 465, 474, 484, 493", "direction"],
    ["Action Storyboard", "direction"],
    ["Unit Director", "direction"],
    ["Series Composition", "script"],
    ["Script", "script"],
    ["Script (German)", "script"],
    ["Screenplay", "script"],
    ["Character Design", "design"],
    ["Sub Character Design", "design"],
    ["Prop Design", "design"],
    ["Cursed Spirit Design", "design"],
    ["Design Works", "design"],
    ["Chief Animation Director", "animation"],
    ["Animation Director (eps 2, 9, 14, 19, 26, 33, 41, 48, 93, 119, 168, 175, 220, 237, 244, 284", "animation"],
    ["Assistant Animation Director", "animation"],
    ["Juju Sanpo Animation Director", "animation"],
    ["Action Director", "animation"],
    ["Layout Design", "animation"],
    ["Main Animator", "animation"],
    ["Effects Animation", "animation"],
    ["Key Animation", "keyAnimation"],
    ["2nd Key Animation", "keyAnimation"],
    ["Key Animation (OP15, OP18, OP20-OP24, eps 621", "keyAnimation"],
    ["Eyecatch Key Animation", "keyAnimation"],
    ["In-Between Animation", "keyAnimation"],
    ["In-between Animation", "keyAnimation"],
    ["In-Betweens Check", "keyAnimation"],
    ["Art Director", "art"],
    ["Art Design", "art"],
    ["Background Art", "art"],
    ["Concept Art", "art"],
    ["Illustration", "art"],
    ["Color Design", "color"],
    ["Color Coordination", "color"],
    ["Color Script", "color"],
    ["Finishing Check", "color"],
    ["Director of Photography", "photography"],
    ["Assistant Director of Photography", "photography"],
    ["Photography", "photography"],
    ["CG Director", "photography"],
    ["CG Modeling", "photography"],
    ["3DCG", "photography"],
    ["2D Works", "photography"],
    ["Special Effects", "photography"],
    ["Editing", "editing"],
    ["Online Editing", "editing"],
    ["Juju Sanpo Editing", "editing"],
    ["Music", "music"],
    ["Music Producer", "music"],
    ["Theme Song Performance", "music"],
    ["Theme Song Performance (Spanish; OP2, OP4, OP5, ED1-ED7)", "music"],
    ["Theme Song Lyrics", "music"],
    ["Insert Song Composition (\"bliss\"; ep 11)", "music"],
    ["Sound Director", "sound"],
    ["Sound Effects", "sound"],
    ["Recording", "sound"],
    ["Recording Adjustment", "sound"],
    ["Foley", "sound"],
    ["ADR Director (English)", "sound"],
    ["ADR Mixing (English)", "sound"],
    ["Producer", "production"],
    ["Animation Producer", "production"],
    ["Executive Producer", "production"],
    ["Planning", "production"],
    ["Co-Planning", "production"],
    ["Production Desk", "production"],
    ["Production Assistant", "production"],
    ["Production Committee", "production"],
    ["Animation", "production"],
    ["CG Production Manager", "production"],
    ["CG Producer", "production"],
    ["Title Logo Design", "other"],
    ["Advertising", "other"],
    ["Advertising Design", "other"],
    ["Publicity", "other"],
    ["Overseas Sales", "other"],
    ["Domestic License", "other"],
    ["Web Production", "other"],
    ["Assistance", "other"],
    ["Something AniList Invents Next Year", "other"],
  ];

  for (const [role, want] of cases) {
    test(`${role} → ${want}`, () => {
      expect(departmentOf(role)).toBe(want as ReturnType<typeof departmentOf>);
    });
  }

  test("a credit with no role is still placed", () => {
    expect(departmentOf(null)).toBe("other");
    expect(departmentOf("   ")).toBe("other");
  });
});

describe("DEPARTMENT_LABEL", () => {
  test("every department is labelled in every language", () => {
    for (const lang of ["zh", "en", "zh-Hant"] as const) {
      for (const key of DEPARTMENTS) {
        expect(DEPARTMENT_LABEL[lang][key]?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  test("the Chinese labels read as the tab's departments", () => {
    expect(DEPARTMENT_LABEL.zh.original).toBe("原作");
    expect(DEPARTMENT_LABEL.zh.keyAnimation).toBe("原画与动画");
    expect(DEPARTMENT_LABEL.zh.other).toBe("其他");
    expect(DEPARTMENT_LABEL["zh-Hant"].music).toBe("音樂");
  });
});

describe("groupStaff", () => {
  const credits: StaffCredit[] = [
    credit(1, "Director"),
    credit(2, "Original Creator"),
    credit(1, "Storyboard (eps 1, 2)"),
    credit(3, "Key Animation"),
    credit(1, "Key Animation (ep 5)"),
    credit(4, "Music"),
    credit(3, "2nd Key Animation"),
    // Pre-0037 rows: no id, one person per name.
    credit(null, "Key Animation", "無番号", "No Id"),
    credit(null, "In-Between Animation", "無番号", "No Id"),
  ];
  const depts = groupStaff(credits);

  test("departments come in the tab's order and empty ones are absent", () => {
    expect(depts.map((d) => d.key)).toEqual(["original", "direction", "keyAnimation", "music"]);
  });

  test("a person is listed once per department, with every role they have there, in order", () => {
    const direction = depts.find((d) => d.key === "direction")!;
    expect(direction.people).toHaveLength(1);
    expect(direction.people[0].roles).toEqual(["Director", "Storyboard (eps 1, 2)"]);

    const key = depts.find((d) => d.key === "keyAnimation")!;
    expect(key.people.map((p) => p.staffId)).toEqual([3, 1, null]);
    expect(key.people[0].roles).toEqual(["Key Animation", "2nd Key Animation"]);
    expect(key.people[2].roles).toEqual(["Key Animation", "In-Between Animation"]);
  });

  test("a person in two departments counts once overall", () => {
    expect(staffPeopleCount(depts)).toBe(5);
  });

  test("no credits, no departments", () => {
    expect(groupStaff([])).toEqual([]);
    expect(staffPeopleCount([])).toBe(0);
  });

  test("the input is not modified", () => {
    const copy = structuredClone(credits);
    groupStaff(credits);
    expect(credits).toEqual(copy);
  });
});

describe("isNamesOnly", () => {
  test(`a department of ${NAMES_ONLY_FROM} people or more lists names only`, () => {
    const many = groupStaff(
      Array.from({ length: NAMES_ONLY_FROM }, (_, i) => credit(i + 1, "Key Animation")),
    );
    expect(isNamesOnly(many[0])).toBe(true);
    const fewer = groupStaff(
      Array.from({ length: NAMES_ONLY_FROM - 1 }, (_, i) => credit(i + 1, "Key Animation")),
    );
    expect(isNamesOnly(fewer[0])).toBe(false);
  });
});

describe("searchStaff", () => {
  const depts = groupStaff([
    { ...credit(1, "Director", "斎藤圭一郎", "Keiichirou Saitou"), nameCn: "斋藤圭一郎" },
    credit(2, "Music", "Evan Call", "Evan Call"),
    credit(3, "Key Animation", "ｶﾀｶﾅ 太郎", "Taro Katakana"),
  ]);

  test("an empty query is the whole list, untouched", () => {
    expect(searchStaff(depts, "  ", "zh")).toBe(depts);
  });

  test("matches names in any script, ignoring case, width and spaces", () => {
    expect(searchStaff(depts, "keiichirou", "zh").map((d) => d.key)).toEqual(["direction"]);
    expect(searchStaff(depts, "斋藤", "zh").map((d) => d.key)).toEqual(["direction"]);
    expect(searchStaff(depts, "evancall", "zh").map((d) => d.key)).toEqual(["music"]);
    expect(searchStaff(depts, "カタカナ", "zh").map((d) => d.key)).toEqual(["keyAnimation"]);
  });

  test("matches a role by its label in the page's language and by AniList's text", () => {
    expect(searchStaff(depts, "监督", "zh").map((d) => d.key)).toEqual(["direction"]);
    expect(searchStaff(depts, "原画", "zh").map((d) => d.key)).toEqual(["keyAnimation"]);
    expect(searchStaff(depts, "key anim", "en").map((d) => d.key)).toEqual(["keyAnimation"]);
  });

  test("a department keeps only the people who matched", () => {
    const both = groupStaff([credit(1, "Key Animation", "甲", "Alpha"), credit(2, "Key Animation", "乙", "Beta")]);
    const got = searchStaff(both, "beta", "en");
    expect(got).toHaveLength(1);
    expect(got[0].people.map((p) => p.staffId)).toEqual([2]);
  });

  test("nothing matched is no departments", () => {
    expect(searchStaff(depts, "nobody at all", "zh")).toEqual([]);
  });
});
