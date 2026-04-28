import { describe, it, expect } from 'vitest'
import { parseEpisodeKind, parseEpisodeMeta } from '../episodeParser.js'

// ─── parseEpisodeKind ────────────────────────────────────────────────────────

describe('parseEpisodeKind', () => {
  // SP / OAD variants → 'sp'
  it("returns 'sp' for bare SP keyword", () => {
    // Arrange
    const filename = '[SubGroup] AnimeTitle SP [1080p].mkv'
    // Act
    const kind = parseEpisodeKind(filename)
    // Assert
    expect(kind).toBe('sp')
  })

  it("returns 'sp' for SP01 keyword", () => {
    const kind = parseEpisodeKind('[SubGroup] AnimeTitle SP01 [1080p].mkv')
    expect(kind).toBe('sp')
  })

  it("returns 'sp' for OAD keyword", () => {
    const kind = parseEpisodeKind('[SubGroup] AnimeTitle OAD [720p].mkv')
    expect(kind).toBe('sp')
  })

  // OVA variants → 'ova'
  it("returns 'ova' for bare OVA keyword", () => {
    const kind = parseEpisodeKind('[SubGroup] AnimeTitle OVA [1080p].mkv')
    expect(kind).toBe('ova')
  })

  it("returns 'ova' for OVA2 keyword", () => {
    const kind = parseEpisodeKind('[SubGroup] AnimeTitle OVA2 [1080p].mkv')
    expect(kind).toBe('ova')
  })

  // Movie variants → 'movie'
  it("returns 'movie' for Movie keyword", () => {
    const kind = parseEpisodeKind('[SubGroup] AnimeTitle Movie [1080p].mkv')
    expect(kind).toBe('movie')
  })

  it("returns 'movie' for 劇場版 (traditional Chinese)", () => {
    const kind = parseEpisodeKind('AnimeTitle 劇場版.mkv')
    expect(kind).toBe('movie')
  })

  it("returns 'movie' for 剧场版 (simplified Chinese)", () => {
    const kind = parseEpisodeKind('AnimeTitle 剧场版.mkv')
    expect(kind).toBe('movie')
  })

  // PV variants → 'pv'
  it("returns 'pv' for bare PV keyword", () => {
    const kind = parseEpisodeKind('[SubGroup] AnimeTitle PV [1080p].mkv')
    expect(kind).toBe('pv')
  })

  it("returns 'pv' for PV01 keyword", () => {
    const kind = parseEpisodeKind('[SubGroup] AnimeTitle PV01 [1080p].mkv')
    expect(kind).toBe('pv')
  })

  it("returns 'pv' for 预告 (simplified Chinese)", () => {
    const kind = parseEpisodeKind('AnimeTitle 预告.mkv')
    expect(kind).toBe('pv')
  })

  it("returns 'pv' for 預告 (traditional Chinese)", () => {
    const kind = parseEpisodeKind('AnimeTitle 預告.mkv')
    expect(kind).toBe('pv')
  })

  // Regular episode → 'main'
  it("returns 'main' for filename with episode number but no special keyword", () => {
    const kind = parseEpisodeKind('[SubGroup] 进击的巨人 - 03 [1080p].mkv')
    expect(kind).toBe('main')
  })

  // Subtitle file with no number, no keyword → 'unknown'
  it("returns 'unknown' for plain English subtitle filename with no number and no keyword", () => {
    const kind = parseEpisodeKind('SomeAnime.srt')
    expect(kind).toBe('unknown')
  })

  // Edge cases
  it("returns 'unknown' for null input", () => {
    const kind = parseEpisodeKind(null)
    expect(kind).toBe('unknown')
  })

  it("returns 'unknown' for empty string", () => {
    const kind = parseEpisodeKind('')
    expect(kind).toBe('unknown')
  })
})

// ─── parseEpisodeMeta ────────────────────────────────────────────────────────

describe('parseEpisodeMeta', () => {
  it('extracts group from standard bracketed format', () => {
    // Arrange
    const filename = '[SubGroup][AnimeTitle][03][1080p].mkv'
    // Act
    const meta = parseEpisodeMeta(filename)
    // Assert
    expect(meta.group).toBe('SubGroup')
  })

  it("extracts '1080p' resolution from bracketed name", () => {
    const meta = parseEpisodeMeta('[SubGroup][AnimeTitle][03][1080p].mkv')
    expect(meta.resolution).toBe('1080p')
  })

  it("normalises 4K to '2160p'", () => {
    const meta = parseEpisodeMeta('[SubGroup] AnimeTitle - 01 [4K].mkv')
    expect(meta.resolution).toBe('2160p')
  })

  it("normalises 4k (lowercase) to '2160p'", () => {
    const meta = parseEpisodeMeta('[SubGroup] AnimeTitle - 01 [4k].mkv')
    expect(meta.resolution).toBe('2160p')
  })

  it("recognises explicit 2160p token", () => {
    const meta = parseEpisodeMeta('[SubGroup] AnimeTitle - 01 [2160p].mkv')
    expect(meta.resolution).toBe('2160p')
  })

  it('sets group to null when filename does not start with a bracket', () => {
    const meta = parseEpisodeMeta('AnimeTitle - 03 [1080p].mkv')
    expect(meta.group).toBeNull()
  })

  it('sets resolution to null for a non-standard resolution like 360p', () => {
    const meta = parseEpisodeMeta('[SubGroup] AnimeTitle - 03 [360p].mkv')
    expect(meta.resolution).toBeNull()
  })

  it('returns all-null object for empty string', () => {
    // Arrange
    const filename = ''
    // Act
    const meta = parseEpisodeMeta(filename)
    // Assert
    expect(meta).toEqual({ title: null, number: null, kind: 'unknown', group: null, resolution: null })
  })

  it('returns all-null object for null input', () => {
    const meta = parseEpisodeMeta(null)
    expect(meta).toEqual({ title: null, number: null, kind: 'unknown', group: null, resolution: null })
  })
})
