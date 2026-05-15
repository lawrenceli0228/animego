import { describe, it, expect } from 'vitest'
import { parseEpisodeKind, parseEpisodeMeta, parseSeason, parseAbsoluteEpisode } from '../episodeParser.js'

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

  // Commentary variants → 'commentary'. Commentary must outrank the
  // digit-fallback so episode-numbered commentary tracks aren't misclassified
  // as main — the negative case below guards the other half of the contract.
  it.each([
    ['[Commentary] bracket tag (Re:Zero S1 EP25 commentary cut)', '[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][25][Commentary][1080P][BDRip][HEVC-10bit][FLAC].mkv'],
    ['[Audio Commentary] variant',                                '[SubGroup] AnimeTitle - 12 [Audio Commentary] [1080p].mkv'],
    ['解说 (simplified Chinese)',                                  'AnimeTitle 12 解说.mkv'],
    ['解說 (traditional Chinese)',                                  'AnimeTitle 12 解說.mkv'],
    ['オーディオコメンタリー (Japanese)',                            'AnimeTitle 12 オーディオコメンタリー.mkv'],
  ])("returns 'commentary' for %s", (_label, filename) => {
    expect(parseEpisodeKind(filename)).toBe('commentary')
  })

  it("does NOT classify a plain ep25 file as commentary just because '25' is present", () => {
    const kind = parseEpisodeKind('[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][25][1080P][BDRip][HEVC-10bit][FLACx2].mkv')
    expect(kind).toBe('main')
  })

  // Regular episode → 'main'
  it("returns 'main' for filename with episode number but no special keyword", () => {
    const kind = parseEpisodeKind('[SubGroup] 进击的巨人 - 03 [1080p].mkv')
    expect(kind).toBe('main')
  })

  // ── BD/Web 特典 kinds (added 2026-05) ──────────────────────────────────────
  // These need their own kind so 方案 D 的 absolute→season 反推不会把它们
  // 当成正片喂进 buildEpisodeMap。
  it.each([
    ['ncop',      '[VCB-Studio][AnimeTitle][NCOP01][BDRip][1080p].mkv'],
    ['ncop',      '[VCB-Studio][AnimeTitle][NC OP1][BDRip][1080p].mkv'],
    ['ncop',      '[Group] AnimeTitle Creditless OP [BDRip].mkv'],
    ['nced',      '[VCB-Studio][AnimeTitle][NCED01][BDRip][1080p].mkv'],
    ['nced',      '[Group] AnimeTitle Creditless ED [BDRip].mkv'],
    ['bonus',     '[Group] AnimeTitle Bonus [BDRip].mkv'],
    ['bonus',     '[Group] AnimeTitle 特典 1 [BDRip].mkv'],
    ['bonus',     '[Group] AnimeTitle Extra 03 [BDRip].mkv'],
    ['bonus',     '[Group] AnimeTitle Disc 2 [BDRip].mkv'],
    ['cm',        '[Group] AnimeTitle CM 15s [BDRip].mkv'],
    ['cm',        '[Group] AnimeTitle CM01 [BDRip].mkv'],
    ['trailer',   '[Group] AnimeTitle Trailer [BDRip].mkv'],
    ['trailer',   '[Group] AnimeTitle Teaser [BDRip].mkv'],
    ['interview', '[Group] AnimeTitle Cast Talk [BDRip].mkv'],
    ['interview', '[Group] AnimeTitle Interview [BDRip].mkv'],
    ['interview', '[Group] AnimeTitle 访谈 [BDRip].mkv'],
    ['wp',        '[Group] AnimeTitle WP 01 [BDRip].mkv'],
    ['wp',        '[Group] AnimeTitle Web Preview 01 [BDRip].mkv'],
    // BD/DVD menu animations — DBD-Raws ships these in `menu/` subfolders
    // with `[menu][01]` style names. Without this rule they'd be tagged
    // 'main' and collide with the real S1E01 in the cluster.
    ['menu',      '[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][menu][01][1080P][BDRip][HEVC-10bit][FLAC].mkv'],
    ['menu',      '[Group] AnimeTitle BD Menu 02 [BDRip].mkv'],
  ])("returns '%s' for matching filename", (expected, filename) => {
    expect(parseEpisodeKind(filename)).toBe(expected)
  })

  // Make sure NCOP is checked BEFORE the digit-fallback so `NCOP01` doesn't
  // become kind='main' (NCOP01 contains a digit; without the dedicated rule
  // the legacy /\d/.test() check pulls it into 'main').
  it("does NOT classify NCOP01 as main just because '01' is present", () => {
    expect(parseEpisodeKind('[VCB-Studio][AnimeTitle][NCOP01][BDRip].mkv')).toBe('ncop')
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

  // Critical contract for commentary cuts: number must still parse so the
  // downstream danmaku lookup hits the matching main episode's track, while
  // kind='commentary' lets the UI route this file into the supplementary lane.
  // title must survive bracket-tag stripping — adding `Commentary` to TAG_RE
  // could regress this if `[Commentary]` ever shadows the title bracket.
  it('extracts number=25, kind=commentary, AND title together for Re:Zero S1 commentary cut', () => {
    const meta = parseEpisodeMeta('[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][25][Commentary][1080P][BDRip][HEVC-10bit][FLAC].mkv')
    expect(meta.number).toBe(25)
    expect(meta.kind).toBe('commentary')
    expect(meta.title).toBeTruthy()
    expect(meta.title).toMatch(/Re Zero/i)
  })

  it('returns all-null object for empty string', () => {
    // Arrange
    const filename = ''
    // Act
    const meta = parseEpisodeMeta(filename)
    // Assert
    expect(meta).toEqual({
      title: null, number: null, kind: 'unknown', group: null, resolution: null,
      season: null, episodeAlt: null,
    })
  })

  it('returns all-null object for null input', () => {
    const meta = parseEpisodeMeta(null)
    expect(meta).toEqual({
      title: null, number: null, kind: 'unknown', group: null, resolution: null,
      season: null, episodeAlt: null,
    })
  })

  // ── DBD-Raws BD bundle real-world cases (test data in /Movies/test) ───────
  // The 10-bit/x265 codec markers contain digits that the legacy fallback
  // path picks up as an episode number. After the codec-token strip these
  // BD-extra files should resolve to either the correct embedded variant
  // index or null — never to 10 (from `10bit`) or 265 (from `x265`).
  it('NCOP1 from a DBD-Raws BD release: kind=ncop, number not stolen from 10bit', () => {
    const meta = parseEpisodeMeta(
      '[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][NCOP1][1080P][BDRip][HEVC-10bit][FLAC].mkv'
    )
    expect(meta.kind).toBe('ncop')
    expect(meta.number).not.toBe(10) // must NOT pull `10` out of `10bit`
    expect(meta.season).toBe(1)
  })

  it('NCED2 from a DBD-Raws BD release: kind=nced, number not stolen from 10bit', () => {
    const meta = parseEpisodeMeta(
      '[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][NCED2][1080P][BDRip][HEVC-10bit][FLAC].mkv'
    )
    expect(meta.kind).toBe('nced')
    expect(meta.number).not.toBe(10)
    expect(meta.season).toBe(1)
  })

  // Regression guard: real episode 10 must still parse correctly when the
  // filename happens to contain `10bit` codec tag. Pattern 5 (`[\d+]`) wins
  // before the fallback runs, so this should be unaffected by the strip.
  it('main S1E10 with HEVC-10bit codec tag still parses number=10', () => {
    const meta = parseEpisodeMeta(
      '[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][10][1080P][BDRip][HEVC-10bit][FLACx2].mkv'
    )
    expect(meta.kind).toBe('main')
    expect(meta.number).toBe(10)
    expect(meta.season).toBe(1)
  })

  // ── The Re:Zero file that motivated this work ─────────────────────────────
  // Filename:  [晚街與燈][Re Zero kara Hajimeru Isekai Seikatsu][4th - 01][總第67]...
  // Before fix: title='Re Zero...', number=1, season undefined → all 4 seasons
  //             share the same cluster key and ep=1 collides with S1E1.
  // After fix:  season=4 (from 4th), number=1 (本季), episodeAlt=67 (总集).
  it('parses Re:Zero 晚街與燈 4th season episode 1 with absolute episode 67', () => {
    const meta = parseEpisodeMeta(
      '[晚街與燈][Re Zero kara Hajimeru Isekai Seikatsu][4th - 01][總第67][WebRip][1080P_AVC_AAC][繁日雙語內嵌].mp4'
    )
    expect(meta.season).toBe(4)
    expect(meta.number).toBe(1)
    expect(meta.episodeAlt).toBe(67)
    expect(meta.title).toMatch(/Re Zero/i)
    expect(meta.kind).toBe('main')
    expect(meta.group).toBe('晚街與燈')
    expect(meta.resolution).toBe('1080p')
  })
})

// ─── parseSeason ─────────────────────────────────────────────────────────────

describe('parseSeason', () => {
  // English ordinals
  it.each([
    ['4th',                                                    4],
    ['4th Season',                                             4],
    ['1st Season',                                             1],
    ['2nd',                                                    2],
    ['3rd Cour',                                               3],
  ])("recognises ordinal '%s' as season %d", (token, expected) => {
    expect(parseSeason(`[Group][AnimeTitle][${token} - 01][BDRip].mkv`)).toBe(expected)
  })

  // SxxExx and Sxx alone
  it('recognises S04E01 as season 4', () => {
    expect(parseSeason('[Group] AnimeTitle S04E01 [1080p].mkv')).toBe(4)
  })
  it('recognises bare S2 token as season 2', () => {
    expect(parseSeason('[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S2][01].mkv')).toBe(2)
  })

  // Season N
  it('recognises Season 4 as season 4', () => {
    expect(parseSeason('AnimeTitle Season 4 - 01 [1080p].mkv')).toBe(4)
  })

  // Chinese ordinals (arabic + Chinese)
  it.each([
    ['第4季',     4],
    ['第四季',    4],
    ['第10季',    10],
    ['第十季',    10],
    ['第2期',     2],
    ['第2部',     2],
  ])("recognises Chinese '%s' as season %d", (token, expected) => {
    expect(parseSeason(`AnimeTitle ${token} 01.mkv`)).toBe(expected)
  })

  // Roman numerals — only when they're clearly season markers, not part of title
  it('recognises Overlord IV as season 4', () => {
    expect(parseSeason('[Group][Overlord IV][01][1080p].mkv')).toBe(4)
  })

  // Negative cases
  it('returns null when no season info is present', () => {
    expect(parseSeason('[Group] AnimeTitle - 01 [1080p].mkv')).toBeNull()
  })
  it('returns null for null/empty input', () => {
    expect(parseSeason(null)).toBeNull()
    expect(parseSeason('')).toBeNull()
  })
})

// ─── parseAbsoluteEpisode ────────────────────────────────────────────────────

describe('parseAbsoluteEpisode', () => {
  it('extracts 67 from 總第67 (traditional)', () => {
    expect(parseAbsoluteEpisode('[Group][Re Zero][4th - 01][總第67][BDRip].mkv')).toBe(67)
  })
  it('extracts 67 from 总第67 (simplified)', () => {
    expect(parseAbsoluteEpisode('[Group][Re Zero][4th - 01][总第67][BDRip].mkv')).toBe(67)
  })
  it('extracts 168 from 總第168 (3 digits)', () => {
    expect(parseAbsoluteEpisode('[Group][Series][总第168][BDRip].mkv')).toBe(168)
  })
  it('handles whitespace between 總第 and the number', () => {
    expect(parseAbsoluteEpisode('[Group][Series][总第 67][BDRip].mkv')).toBe(67)
  })
  it('returns null when 總第 token is absent', () => {
    expect(parseAbsoluteEpisode('[Group][AnimeTitle][01][1080p].mkv')).toBeNull()
  })
  it('returns null for null/empty input', () => {
    expect(parseAbsoluteEpisode(null)).toBeNull()
    expect(parseAbsoluteEpisode('')).toBeNull()
  })
})
