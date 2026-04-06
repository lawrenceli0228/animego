const { normalize } = require('../services/anilist.service');

describe('anilist.service — normalize()', () => {
  it('normalizes a minimal AniList media object', () => {
    const media = {
      id: 101,
      title: { romaji: 'Test Anime', english: 'Test Anime EN', native: 'テスト' },
      coverImage: { extraLarge: 'https://img/xl.jpg', large: 'https://img/l.jpg' },
      bannerImage: 'https://img/banner.jpg',
      description: '<p>A test anime</p>',
      episodes: 12,
      status: 'RELEASING',
      season: 'WINTER',
      seasonYear: 2026,
      averageScore: 85,
      genres: ['Action', 'Drama'],
      format: 'TV',
    };

    const result = normalize(media);

    expect(result.anilistId).toBe(101);
    expect(result.titleRomaji).toBe('Test Anime');
    expect(result.titleEnglish).toBe('Test Anime EN');
    expect(result.titleNative).toBe('テスト');
    expect(result.coverImageUrl).toBe('https://img/xl.jpg');
    expect(result.bannerImageUrl).toBe('https://img/banner.jpg');
    expect(result.episodes).toBe(12);
    expect(result.season).toBe('WINTER');
    expect(result.seasonYear).toBe(2026);
    expect(result.averageScore).toBe(85);
    expect(result.genres).toEqual(['Action', 'Drama']);
    expect(result.format).toBe('TV');
    expect(result.cachedAt).toBeInstanceOf(Date);
  });

  it('falls back to large cover when extraLarge missing', () => {
    const media = {
      id: 1,
      title: {},
      coverImage: { large: 'https://img/l.jpg' },
      genres: [],
    };
    expect(normalize(media).coverImageUrl).toBe('https://img/l.jpg');
  });

  it('normalizes studios when present', () => {
    const media = {
      id: 1,
      title: {},
      genres: [],
      studios: { nodes: [{ name: 'MAPPA' }, { name: 'Bones' }] },
    };
    expect(normalize(media).studios).toEqual(['MAPPA', 'Bones']);
  });

  it('normalizes characters when present', () => {
    const media = {
      id: 1,
      title: {},
      genres: [],
      characters: {
        edges: [{
          node: { name: { full: 'Eren Yeager', native: 'エレン・イェーガー' }, image: { medium: 'https://img/char.jpg' } },
          role: 'MAIN',
          voiceActors: [{ name: { full: 'Yuki Kaji', native: '梶裕貴' }, image: { medium: 'https://img/va.jpg' } }],
        }],
      },
    };
    const result = normalize(media);
    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].nameEn).toBe('Eren Yeager');
    expect(result.characters[0].nameJa).toBe('エレン・イェーガー');
    expect(result.characters[0].role).toBe('MAIN');
    expect(result.characters[0].voiceActorEn).toBe('Yuki Kaji');
  });

  it('normalizes staff when present', () => {
    const media = {
      id: 1,
      title: {},
      genres: [],
      staff: {
        edges: [{
          node: { name: { full: 'Hajime Isayama', native: '諫山創' }, image: { medium: 'https://img/staff.jpg' } },
          role: 'Original Creator',
        }],
      },
    };
    const result = normalize(media);
    expect(result.staff).toHaveLength(1);
    expect(result.staff[0].nameEn).toBe('Hajime Isayama');
    expect(result.staff[0].role).toBe('Original Creator');
  });

  it('normalizes recommendations when present', () => {
    const media = {
      id: 1,
      title: {},
      genres: [],
      recommendations: {
        nodes: [
          { mediaRecommendation: { id: 200, title: { romaji: 'Rec Anime' }, coverImage: { large: 'https://img/rec.jpg' }, averageScore: 80 } },
          { mediaRecommendation: null }, // filtered out
        ],
      },
    };
    const result = normalize(media);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].anilistId).toBe(200);
  });

  it('normalizes relations when present', () => {
    const media = {
      id: 1,
      title: {},
      genres: [],
      relations: {
        edges: [{
          relationType: 'SEQUEL',
          node: { id: 300, title: { romaji: 'Sequel Anime', native: '続編' } },
        }],
      },
    };
    const result = normalize(media);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].relationType).toBe('SEQUEL');
    expect(result.relations[0].anilistId).toBe(300);
  });

  it('defaults genres to empty array when missing', () => {
    const media = { id: 1, title: {} };
    expect(normalize(media).genres).toEqual([]);
  });
});
