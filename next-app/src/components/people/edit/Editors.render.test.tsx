import { afterAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// renderToStaticMarkup, as the page views' render test: what the server sends
// for the edit state, before anything hydrates. useRouter needs the app
// router's context, which a static render has not got, so only it is
// replaced; everything else is the real module. What the controls do is the
// model's tests (lib/people/edit) and the browser's (e2e people-edit.spec).

const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation,
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}));

const { LanguageProvider } = await import("@/lib/lang-client");
const { default: CharacterEditor } = await import("./CharacterEditor");
const { default: PersonEditor } = await import("./PersonEditor");
type Character = import("@/lib/people/types").Character;
type Person = import("@/lib/people/types").Person;
type Lang = import("@/lib/i18n/lang").Lang;

afterAll(() => {
  mock.restore();
});

const FRIEREN = {
  anilistId: 154587,
  titleRomaji: "Sousou no Frieren",
  titleEnglish: null,
  titleNative: null,
  titleChinese: "葬送的芙莉莲",
  titleHant: null,
  titleHantSeo: null,
  coverImageUrl: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/154587.jpg",
  format: "TV",
  year: 2023,
  popularity: 480000,
  posterAccent: null,
};

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
      person: { anilistId: 115100, name: { full: "Arisa Kiyoto", native: null, cn: "清都亚里沙" }, image: null },
      language: "Japanese",
      roleNotes: "Childhood",
      line: null,
    },
  ],
  appearances: [{ anime: FRIEREN, role: "MAIN" }],
  bangumiDescription: null,

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
  voiceWorkCount: 1,
  staffWorkCount: 0,

  indexable: false,
};

function character(lang: Lang = "zh"): string {
  return renderToStaticMarkup(
    <LanguageProvider lang={lang}>
      <CharacterEditor character={STARK} lang={lang} crumbs={<nav>crumbs</nav>} pageHref="/character/184313" />
    </LanguageProvider>,
  );
}

function person(lang: Lang = "zh"): string {
  return renderToStaticMarkup(
    <LanguageProvider lang={lang}>
      <PersonEditor
        person={KOBAYASHI}
        lang={lang}
        crumbs={<nav>crumbs</nav>}
        representative={<section>代表角色</section>}
        pageHref="/person/133507"
      />
    </LanguageProvider>,
  );
}

const submits = (html: string) => [...html.matchAll(/<button type="submit"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

describe("the character's edit state", () => {
  const html = character();

  test("every value the page shows is a field holding it", () => {
    expect(html).toContain('aria-label="中文名" maxLength="100" data-changed="false" value="修塔尔克"');
    expect(html).toContain('value="シュタルク"');
    expect(html).toContain('value="Stark"');
    expect(html).toContain("休塔尔克");
    expect(html).toContain('aria-label="移除别名 休塔尔克"');
    expect(html).toMatch(/<select id="edit-gender"[\s\S]*?<option value="Male" selected="">男<\/option>/);
    expect(html).toContain(">A warrior.</textarea>");
  });

  test("voices: each line in a field, 更换, remove, and + 添加声优", () => {
    expect(html).toContain('aria-label="配音备注" maxLength="60" value="日配"');
    expect(html).toContain('value="日配 · 童年"');
    expect(html.match(/>更换</g)).toHaveLength(2);
    expect(html.match(/aria-label="移除声优"/g)).toHaveLength(2);
    expect(html).toContain("+ 添加声优");
  });

  test("the birthday as the page shows it: month and day, and the year when it has one", () => {
    expect(html).toContain('aria-label="出生月"');
    expect(html).not.toContain('aria-label="出生年"');
    const withYear = { ...STARK, profile: { ...STARK.profile!, birth: { year: 2199, month: 4, day: 1 } } };
    const dated = renderToStaticMarkup(
      <LanguageProvider lang="zh">
        <CharacterEditor character={withYear} lang="zh" crumbs={<nav>crumbs</nav>} pageHref="/character/184313" />
      </LanguageProvider>,
    );
    expect(dated).toContain('aria-label="出生年" maxLength="4" data-changed="false" value="2199"');
  });

  test("the role on each title is a select", () => {
    expect(html).toMatch(/<select[^>]*aria-label="在《葬送的芙莉莲》中的定位"[\s\S]*?<option value="MAIN" selected="">主角<\/option>/);
  });

  test("the source is required, the note is not; nothing explains anything", () => {
    expect(html).toMatch(/<input[^>]*required=""[^>]*aria-label="来源链接"/);
    expect(html).toContain('placeholder="说明（可选）"');
    expect(html).not.toContain("资料来自");
  });

  test("two bars, one per width: 提交 in the phone's, 提交审核 beside the name; both wait for a change", () => {
    expect(submits(html)).toEqual(["提交", "提交审核"]);
    expect(html.match(/<button type="submit"[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain("已改");
  });

  test("English", () => {
    const en = character("en");
    expect(submits(en)).toEqual(["Submit", "Submit for review"]);
    expect(en).toContain('aria-label="Chinese name"');
    expect(en).toContain('value="Japanese"');
    // The big field is the name the English page leads with.
    expect(en).toMatch(/<input id="edit-name"[^>]*aria-label="Romanised name"[^>]*value="Stark"/);
    expect(html).toMatch(/<input id="edit-name"[^>]*aria-label="中文名"[^>]*value="修塔尔克"/);
  });
});

describe("the person's edit state", () => {
  const html = person();

  test("names, occupations, the facts in the reader's language, 代表角色 as on the page", () => {
    expect(html).toContain('value="小林千晃"');
    expect(html).toContain('aria-label="移除职业 声优"');
    expect(html).toContain('aria-label="出生年" maxLength="4" data-changed="false" value="1994"');
    expect(html).toContain('value="神奈川县"');
    expect(html).toContain("<section>代表角色</section>");
    expect(submits(html)).toEqual(["提交", "提交审核"]);
  });

  test("no character fields", () => {
    expect(html).not.toContain("配音备注");
    expect(html).not.toContain('aria-label="移除别名');
    expect(html).not.toContain("<textarea");
  });
});
