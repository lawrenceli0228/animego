import { formatScore, stripHtml, truncate, pickTitle } from '../utils/formatters';

describe('formatScore', () => {
  it('converts integer score to decimal string', () => {
    expect(formatScore(85)).toBe('8.5');
  });

  it('returns N/A for falsy score', () => {
    expect(formatScore(0)).toBe('N/A');
    expect(formatScore(null)).toBe('N/A');
    expect(formatScore(undefined)).toBe('N/A');
  });
});

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>World</b></p>')).toBe('Hello World');
  });

  it('replaces HTML entities with spaces', () => {
    expect(stripHtml('Hello&nbsp;World')).toBe('Hello World');
  });

  it('returns empty string for falsy input', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml('')).toBe('');
  });

  it('trims whitespace', () => {
    expect(stripHtml('  <span>text</span>  ')).toBe('text');
  });
});

describe('truncate', () => {
  it('truncates string longer than limit', () => {
    const long = 'a'.repeat(200);
    const result = truncate(long, 150);
    expect(result).toHaveLength(153); // 150 + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('returns string as-is when shorter than limit', () => {
    expect(truncate('short', 150)).toBe('short');
  });

  it('returns falsy input unchanged', () => {
    expect(truncate(null)).toBeNull();
    expect(truncate(undefined)).toBeUndefined();
  });

  it('uses default limit of 150', () => {
    const exact = 'a'.repeat(150);
    expect(truncate(exact)).toBe(exact);
    const over = 'a'.repeat(151);
    expect(truncate(over).endsWith('...')).toBe(true);
  });
});

describe('pickTitle', () => {
  const anime = {
    titleChinese: '进击的巨人',
    titleNative: '進撃の巨人',
    titleRomaji: 'Shingeki no Kyojin',
    titleEnglish: 'Attack on Titan',
  };

  describe('zh language', () => {
    it('prefers titleChinese', () => {
      expect(pickTitle(anime, 'zh')).toBe('进击的巨人');
    });

    it('falls back to titleNative when no Chinese', () => {
      const { titleChinese, ...rest } = anime;
      expect(pickTitle(rest, 'zh')).toBe('進撃の巨人');
    });

    it('falls back to titleRomaji when no Chinese or Native', () => {
      expect(pickTitle({ titleRomaji: 'Shingeki', titleEnglish: 'Attack' }, 'zh')).toBe('Shingeki');
    });

    it('falls back to titleEnglish as last resort', () => {
      expect(pickTitle({ titleEnglish: 'Attack on Titan' }, 'zh')).toBe('Attack on Titan');
    });

    it('returns empty string when no titles available', () => {
      expect(pickTitle({}, 'zh')).toBe('');
    });
  });

  describe('en language', () => {
    it('prefers titleEnglish', () => {
      expect(pickTitle(anime, 'en')).toBe('Attack on Titan');
    });

    it('falls back to titleRomaji when no English', () => {
      const { titleEnglish, ...rest } = anime;
      expect(pickTitle(rest, 'en')).toBe('Shingeki no Kyojin');
    });

    it('returns empty string when no English or Romaji', () => {
      expect(pickTitle({ titleChinese: '中文', titleNative: '日本語' }, 'en')).toBe('');
    });
  });
});
