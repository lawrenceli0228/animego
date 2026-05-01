// @ts-check
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMatchAnime = vi.fn();
vi.mock('../api/dandanplay.api', () => ({
  matchAnime: (...args) => mockMatchAnime(...args),
}));

import { createDandanClient } from '../services/dandanClient.js';

describe('dandanClient.match', () => {
  beforeEach(() => {
    mockMatchAnime.mockReset();
  });

  it('matched=true with anime fields → returns isMatched + animes + enrichment', async () => {
    mockMatchAnime.mockResolvedValueOnce({
      matched: true,
      anime: {
        dandanAnimeId: 12345,
        titleChinese: '我的青春恋爱物语果然有问题',
        titleRomaji: 'Yahari Ore no Seishun',
        titleNative: 'やはり俺の青春',
        coverImageUrl: 'https://example.test/cover.jpg',
      },
    });

    const client = createDandanClient();
    const result = await client.match('hash16m', 'show.mkv', { fileSize: 9000 });

    expect(result).toEqual({
      isMatched: true,
      animes: [{ animeId: 12345, animeTitle: '我的青春恋爱物语果然有问题' }],
      enrichment: {
        titleZh: '我的青春恋爱物语果然有问题',
        titleEn: 'Yahari Ore no Seishun',
        posterUrl: 'https://example.test/cover.jpg',
      },
    });

    // Body shape — episodes:[1] + files[0].episode:1 are required by the
    // server controller's buildEpisodeMap step (see dandanClient.js header).
    expect(mockMatchAnime).toHaveBeenCalledWith({
      fileName: 'show.mkv',
      fileHash: 'hash16m',
      fileSize: 9000,
      episodes: [1],
      files: [{ fileName: 'show.mkv', fileHash: 'hash16m', fileSize: 9000, episode: 1 }],
    });
  });

  it('matched=true but no dandanAnimeId → falls back to animeId field', async () => {
    mockMatchAnime.mockResolvedValueOnce({
      matched: true,
      anime: { animeId: 777, titleNative: 'Native Only' },
    });

    const result = await createDandanClient().match('h', 'f.mkv');
    expect(result?.animes[0].animeId).toBe(777);
    // titleNative becomes titleEn when titleRomaji is absent
    expect(result?.enrichment).toEqual({ titleEn: 'Native Only' });
  });

  it('Phase 1 response — titles in siteAnime → merges into enrichment', async () => {
    // Real-world Phase 1 server response: anime has only titleNative + cover,
    // siteAnime carries titleChinese/titleRomaji from AnimeCache. Refresh must
    // see all three on the Series record.
    mockMatchAnime.mockResolvedValueOnce({
      matched: true,
      anime: {
        titleNative: '機動戦士ガンダム 水星の魔女',
        coverImageUrl: 'https://example.test/g.jpg',
      },
      siteAnime: {
        anilistId: 153093,
        titleChinese: '机动战士高达 水星的魔女',
        titleRomaji: 'Kidou Senshi Gundam: Suisei no Majo',
        titleNative: '機動戦士ガンダム 水星の魔女',
        coverImageUrl: 'https://example.test/g.jpg',
      },
    });

    const result = await createDandanClient().match('h', 'g.mkv');
    expect(result?.isMatched).toBe(true);
    expect(result?.enrichment).toEqual({
      titleZh: '机动战士高达 水星的魔女',
      titleEn: 'Kidou Senshi Gundam: Suisei no Majo',
      posterUrl: 'https://example.test/g.jpg',
    });
  });

  it('matched=false → returns null', async () => {
    mockMatchAnime.mockResolvedValueOnce({ matched: false });
    const result = await createDandanClient().match('h', 'f.mkv');
    expect(result).toBeNull();
  });

  it('thrown error → returns null (network failure must not brick import)', async () => {
    mockMatchAnime.mockRejectedValueOnce(new Error('boom'));
    const result = await createDandanClient().match('h', 'f.mkv');
    expect(result).toBeNull();
  });

  it('missing hash16M → returns null without calling backend', async () => {
    const result = await createDandanClient().match('', 'f.mkv');
    expect(result).toBeNull();
    expect(mockMatchAnime).not.toHaveBeenCalled();
  });

  it('matched=true with no animeId anywhere → still returns enrichment (animeId:0)', async () => {
    // The server controller currently doesn't echo dandanAnimeId in Phase 1
    // responses. We tolerate this for the refresh use case (which only needs
    // enrichment) — caller can decide whether to act on animeId:0.
    mockMatchAnime.mockResolvedValueOnce({
      matched: true,
      anime: { titleChinese: 'No Id Anime', coverImageUrl: 'https://x' },
    });
    const result = await createDandanClient().match('h', 'f.mkv');
    expect(result?.isMatched).toBe(true);
    expect(result?.animes[0].animeId).toBe(0);
    expect(result?.enrichment).toEqual({
      titleZh: 'No Id Anime',
      posterUrl: 'https://x',
    });
  });
});
