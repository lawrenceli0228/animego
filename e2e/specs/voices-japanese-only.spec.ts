import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * Voices are Japanese only: the AniList query asks for Japanese voices, the
 * store keeps no other language, and the characters API answers every `lang`
 * with the Japanese list.
 *
 *   - 16498 (Attack on Titan) carried Korean voices beside the Japanese ones.
 *   - 126403 (Link Click) is a Chinese production whose main voices were
 *     Chinese, with Japanese voices for part of the cast.
 *   - 163264 voiced only in Chinese, so no credit names them any more and
 *     their person page is gone.
 *
 * Every request carries a throwaway query parameter so Cloudflare cannot
 * answer it from a copy cached before the change; the handlers ignore it.
 */

const TITLES_THAT_HAD_OTHER_DUBS = [16498, 126403];
const CHINESE_ONLY_VOICE_ACTOR = 163264;

const fresh = () => `_=${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

interface CharacterVoice {
  staffId: number;
}
interface CharacterRow {
  characterId: number;
  voices: CharacterVoice[];
}
interface CharactersPage {
  data: CharacterRow[];
  language: string;
  counts: { languages: { language: string; count: number }[] };
}

async function characters(request: APIRequestContext, id: number, lang: string): Promise<CharactersPage> {
  const res = await request.get(`/api/anime/${id}/characters?lang=${lang}&limit=100&${fresh()}`);
  expect(res.status(), `/api/anime/${id}/characters?lang=${lang}`).toBe(200);
  return res.json();
}

const voiceMap = (page: CharactersPage) => page.data.map((c) => [c.characterId, c.voices.map((v) => v.staffId)]);

for (const id of TITLES_THAT_HAD_OTHER_DUBS) {
  test(`characters API for ${id}: Japanese voices only, whatever lang asks for`, async ({ request }) => {
    const ja = await characters(request, id, "ja");
    expect(ja.counts.languages.map((l) => l.language)).toEqual(["ja"]);
    expect(ja.data.some((c) => c.voices.length > 0)).toBe(true);

    for (const lang of ["zh", "ko"]) {
      const other = await characters(request, id, lang);
      expect(other.language, `lang=${lang} is answered as`).toBe("ja");
      expect(other.counts.languages, `lang=${lang} counts`).toEqual(ja.counts.languages);
      expect(voiceMap(other), `lang=${lang} answers like ja`).toEqual(voiceMap(ja));
    }
  });

  test(`characters page for ${id} offers no other dub`, async ({ page }) => {
    await page.goto(`/anime/${id}/characters?${fresh()}`);
    await expect(page.locator("h1").first()).toBeVisible();

    const cast = page.getByRole("region", { name: "角色与配音" });
    await expect(cast.getByRole("listitem").first()).toBeVisible();
    await expect(cast).toContainText("日配");
    await expect(cast).not.toContainText(/中配|韩配|韓配/);
    // One dub is no choice, so there is no switch.
    await expect(page.getByRole("group", { name: "配音语言" })).toHaveCount(0);
  });
}

test("Link Click's detail cast names only voices from its Japanese list", async ({ request }) => {
  const ja = await characters(request, 126403, "ja");
  const japanese = new Set(ja.data.flatMap((c) => c.voices.map((v) => v.staffId)));

  const res = await request.get(`/api/anime/126403?${fresh()}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  const cast: { voiceActorId: number | null }[] = (body.data ?? body).characters ?? [];
  expect(cast.length).toBeGreaterThan(0);

  const named = cast.filter((c) => c.voiceActorId != null);
  expect(named.length).toBeGreaterThan(0);
  for (const c of named) expect(japanese.has(c.voiceActorId as number), `voice actor ${c.voiceActorId}`).toBe(true);
});

test("a voice actor who only voiced in Chinese has no page", async ({ request }) => {
  const res = await request.get(`/api/people/${CHINESE_ONLY_VOICE_ACTOR}?${fresh()}`);
  expect(res.status()).toBe(404);
});
