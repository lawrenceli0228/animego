import { describe, it, expect } from 'vitest';
import { normalizeTokens } from '../lib/library/normalize';

describe('normalizeTokens', () => {
  it('returns [] for empty string', () => {
    expect(normalizeTokens('')).toEqual([]);
  });

  it('returns [] for whitespace-only string', () => {
    expect(normalizeTokens('  ')).toEqual([]);
  });

  it('returns [] for null/undefined', () => {
    expect(normalizeTokens(null)).toEqual([]);
    expect(normalizeTokens(undefined)).toEqual([]);
  });

  it('strips leading bracket group tags and noise from typical fansub filename', () => {
    const tokens = normalizeTokens(
      '[LoliHouse] Oshi no Ko S3 [01-11] [WebRip 1080p HEVC-10bit AAC SRTx2]'
    );
    // should contain "oshi", "no", "ko" but not "loli...", "1080p", "hevc", "aac" etc.
    expect(tokens).toContain('oshi');
    expect(tokens).toContain('no');
    expect(tokens).toContain('ko');
    // noise tokens stripped
    expect(tokens).not.toContain('1080p');
    expect(tokens).not.toContain('hevc');
    expect(tokens).not.toContain('aac');
    expect(tokens).not.toContain('webrip');
    expect(tokens).not.toContain('srtx2');
    // episode range stripped
    expect(tokens).not.toContain('01-11');
    // leading group stripped
    expect(tokens).not.toContain('lolihouse');
  });

  it('converts full-width digits and letters to half-width (NFKC)', () => {
    // 第４季 → 第4季
    const tokens = normalizeTokens('進撃の巨人 第４季');
    const joined = tokens.join(' ');
    expect(joined).toContain('4');
    expect(joined).not.toContain('４');
  });

  it('strips episode-number tokens (S3, E01, EP12)', () => {
    const tokens = normalizeTokens('My Anime S3 E01 EP12');
    expect(tokens).not.toContain('s3');
    expect(tokens).not.toContain('e01');
    expect(tokens).not.toContain('ep12');
  });

  it('splits on punctuation and whitespace into trimmed tokens', () => {
    const tokens = normalizeTokens('Sword Art Online: Alicization');
    expect(tokens).toContain('sword');
    expect(tokens).toContain('art');
    expect(tokens).toContain('online');
    expect(tokens).toContain('alicization');
  });

  it('strips (group) parenthesised leading tags', () => {
    const tokens = normalizeTokens('(SubRip) My Anime - 01 [720p]');
    expect(tokens).not.toContain('subrip');
    expect(tokens).toContain('my');
    expect(tokens).toContain('anime');
  });

  it('strips 【group】 leading full-width bracket tags', () => {
    const tokens = normalizeTokens('【字幕組】進撃の巨人 01');
    const joined = tokens.join(' ');
    expect(joined).not.toContain('字幕組');
  });

  it('strips codec noise: x264 x265 hevc avc bluray bdrip', () => {
    const tokens = normalizeTokens('Anime x264 x265 HEVC AVC BluRay BDRip 01');
    const flat = tokens.join(' ');
    expect(flat).not.toContain('x264');
    expect(flat).not.toContain('x265');
    expect(flat).not.toContain('hevc');
    expect(flat).not.toContain('avc');
    expect(flat).not.toContain('bluray');
    expect(flat).not.toContain('bdrip');
  });

  it('filters empty tokens after split', () => {
    const tokens = normalizeTokens('---');
    expect(tokens.every(t => t.length > 0)).toBe(true);
  });
});
