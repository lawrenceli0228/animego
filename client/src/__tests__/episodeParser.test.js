import { isVideoFile, parseEpisodeNumber, parseAnimeKeyword, dandanToArtplayer } from '../utils/episodeParser'

describe('isVideoFile', () => {
  it('accepts common video extensions', () => {
    expect(isVideoFile('video.mkv')).toBe(true)
    expect(isVideoFile('video.mp4')).toBe(true)
    expect(isVideoFile('video.avi')).toBe(true)
    expect(isVideoFile('video.webm')).toBe(true)
    expect(isVideoFile('video.flv')).toBe(true)
    expect(isVideoFile('video.rmvb')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isVideoFile('video.MKV')).toBe(true)
    expect(isVideoFile('video.Mp4')).toBe(true)
  })

  it('rejects non-video files', () => {
    expect(isVideoFile('image.png')).toBe(false)
    expect(isVideoFile('subtitle.ass')).toBe(false)
    expect(isVideoFile('readme.txt')).toBe(false)
    expect(isVideoFile('NCOP.jpg')).toBe(false)
  })
})

describe('parseEpisodeNumber', () => {
  it('parses S01E03 format', () => {
    expect(parseEpisodeNumber('[SubGroup] Anime S01E03 [1080p].mkv')).toBe(3)
    expect(parseEpisodeNumber('Show.S02E12.mkv')).toBe(12)
  })

  it('parses EP03 format', () => {
    expect(parseEpisodeNumber('[SubGroup] Anime EP03 [1080p].mkv')).toBe(3)
    expect(parseEpisodeNumber('Anime EP12.mkv')).toBe(12)
  })

  it('parses 第3集 format', () => {
    expect(parseEpisodeNumber('进击的巨人 第3集.mkv')).toBe(3)
    expect(parseEpisodeNumber('动画 第12話.mkv')).toBe(12)
    expect(parseEpisodeNumber('动画 第5话.mkv')).toBe(5)
  })

  it('parses " - 03 " dash-separated format', () => {
    expect(parseEpisodeNumber('[SubGroup] Anime - 03 [1080p].mkv')).toBe(3)
    expect(parseEpisodeNumber('Anime Title - 12 [720p].mkv')).toBe(12)
  })

  it('parses [03] bracket format', () => {
    expect(parseEpisodeNumber('[SubGroup] Anime [03][1080p].mkv')).toBe(3)
    expect(parseEpisodeNumber('[Group] Anime [07v2].mkv')).toBe(7)
  })

  it('filters out resolution numbers', () => {
    expect(parseEpisodeNumber('Anime 1080p.mkv')).toBe(null)
    expect(parseEpisodeNumber('Anime [720].mkv')).toBe(null)
    expect(parseEpisodeNumber('Anime [1080].mkv')).toBe(null)
  })

  it('returns null for NCOP/NCED with no episode number', () => {
    expect(parseEpisodeNumber('NCOP.mkv')).toBe(null)
    expect(parseEpisodeNumber('NCED.mkv')).toBe(null)
  })

  it('uses fallback for standalone 2-digit numbers', () => {
    expect(parseEpisodeNumber('Anime_05_final.mkv')).toBe(5)
  })
})

describe('parseAnimeKeyword', () => {
  it('extracts keyword from bracket-heavy filenames', () => {
    const result = parseAnimeKeyword('[SubGroup] My Anime - 03 [1080p][HEVC].mkv')
    expect(result).toBe('My Anime')
  })

  it('extracts keyword from EP format', () => {
    const result = parseAnimeKeyword('[Group] Another Show EP05 [720p].mkv')
    expect(result).toBe('Another Show')
  })

  it('strips resolution and codec tags', () => {
    const result = parseAnimeKeyword('Cool Anime 1080p x264 AAC.mkv')
    expect(result).not.toContain('1080')
    expect(result).not.toContain('x264')
    expect(result).not.toContain('AAC')
  })

  it('strips source tags', () => {
    const result = parseAnimeKeyword('Anime BDRip WEB-DL.mkv')
    expect(result).not.toMatch(/BDRip/i)
    expect(result).not.toMatch(/WEB-DL/i)
  })

  it('extracts title from all-bracket filenames', () => {
    const result = parseAnimeKeyword('[UHA-WINGS][Kaguya-sama wa Kokurasetai - Otona e no Kaidan][02][1080p HEVC][CHS].mp4')
    expect(result).toBe('Kaguya-sama wa Kokurasetai - Otona e no Kaidan')
  })

  it('picks longest non-tag bracket as title', () => {
    const result = parseAnimeKeyword('[Lilith-Raws][Sousou no Frieren][01][1080p][AVC AAC].mkv')
    expect(result).toBe('Sousou no Frieren')
  })

  it('returns null for empty input', () => {
    expect(parseAnimeKeyword('')).toBe(null)
    expect(parseAnimeKeyword(null)).toBe(null)
  })
})

describe('dandanToArtplayer', () => {
  it('converts scroll mode (1 -> 0)', () => {
    const result = dandanToArtplayer({ p: '100.5,1,16777215', m: 'hello' })
    expect(result).toEqual({
      text: 'hello',
      time: 100.5,
      mode: 0,
      color: '#ffffff',
    })
  })

  it('converts bottom mode (4 -> 2)', () => {
    const result = dandanToArtplayer({ p: '50,4,255', m: 'bottom text' })
    expect(result.mode).toBe(2)
  })

  it('converts top mode (5 -> 1)', () => {
    const result = dandanToArtplayer({ p: '30,5,16711680', m: 'top text' })
    expect(result.mode).toBe(1)
    expect(result.color).toBe('#ff0000')
  })

  it('falls back to scroll (mode 0) for unknown mode', () => {
    const result = dandanToArtplayer({ p: '10,9,0', m: 'unknown mode' })
    expect(result.mode).toBe(0)
  })

  it('converts RGB integer to hex color with padding', () => {
    // color = 255 → #0000ff
    const result = dandanToArtplayer({ p: '0,1,255', m: 'blue' })
    expect(result.color).toBe('#0000ff')
  })

  it('converts black color (0) correctly', () => {
    const result = dandanToArtplayer({ p: '0,1,0', m: 'black' })
    expect(result.color).toBe('#000000')
  })

  it('preserves danmaku text', () => {
    const result = dandanToArtplayer({ p: '0,1,0', m: '这是弹幕文本 🎉' })
    expect(result.text).toBe('这是弹幕文本 🎉')
  })
})
