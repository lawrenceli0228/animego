import { render, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const ctorCalls = []
const subtitleStyle = vi.fn()
const subtitleSwitch = vi.fn()
const danmukuConfig = vi.fn()
const danmukuLoad = vi.fn()

function makeArtInstance(config) {
  ctorCalls.push(config)
  return {
    on: vi.fn(),
    destroy: vi.fn(),
    subtitle: { style: subtitleStyle, switch: subtitleSwitch },
    plugins: {
      artplayerPluginDanmuku: { config: danmukuConfig, load: danmukuLoad },
    },
    currentTime: 0,
    duration: 1200,
  }
}

vi.mock('artplayer', () => ({
  default: vi.fn(function ArtplayerMock(config) {
    return makeArtInstance(config)
  }),
}))

vi.mock('artplayer-plugin-danmuku', () => ({
  default: vi.fn(() => ({ name: 'artplayerPluginDanmuku' })),
}))

import VideoPlayer from '../components/player/VideoPlayer'

const SIZE_KEY = 'animego:subtitleFontSize'
const OFFSET_KEY = 'animego:subtitleOffset'

beforeEach(() => {
  ctorCalls.length = 0
  subtitleStyle.mockClear()
  subtitleSwitch.mockClear()
  danmukuConfig.mockClear()
  danmukuLoad.mockClear()
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('VideoPlayer subtitle slider settings', () => {
  test('uses defaults (20px size, 60px offset) when no preferences stored', () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    expect(ctorCalls).toHaveLength(1)
    expect(ctorCalls[0].subtitle.style.fontSize).toBe('20px')
    expect(ctorCalls[0].subtitle.style.bottom).toBe('60px')
    const [sizeSetting, offsetSetting] = ctorCalls[0].settings
    expect(sizeSetting.tooltip).toBe('20px')
    expect(sizeSetting.range).toEqual([20, 14, 48, 2])
    expect(offsetSetting.tooltip).toBe('60px')
    expect(offsetSetting.range).toEqual([60, 10, 200, 5])
  })

  test('hydrates stored preferences into slider initial values', () => {
    window.localStorage.setItem(SIZE_KEY, '32')
    window.localStorage.setItem(OFFSET_KEY, '140')
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    expect(ctorCalls[0].subtitle.style.fontSize).toBe('32px')
    expect(ctorCalls[0].subtitle.style.bottom).toBe('140px')
    expect(ctorCalls[0].settings[0].range[0]).toBe(32)
    expect(ctorCalls[0].settings[1].range[0]).toBe(140)
  })

  test('clamps out-of-range stored values into [min,max]', () => {
    window.localStorage.setItem(SIZE_KEY, '999')
    window.localStorage.setItem(OFFSET_KEY, '-10')
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    expect(ctorCalls[0].subtitle.style.fontSize).toBe('48px')
    expect(ctorCalls[0].subtitle.style.bottom).toBe('10px')
  })

  test('size slider onChange persists and applies fontSize', () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    const sizeSetting = ctorCalls[0].settings[0]
    const result = sizeSetting.onChange({ range: [28] })
    expect(result).toBe('28px')
    expect(window.localStorage.getItem(SIZE_KEY)).toBe('28')
    expect(subtitleStyle).toHaveBeenCalledWith({ fontSize: '28px' })
  })

  test('offset slider onChange persists and applies bottom', () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    const offsetSetting = ctorCalls[0].settings[1]
    const result = offsetSetting.onChange({ range: [120] })
    expect(result).toBe('120px')
    expect(window.localStorage.getItem(OFFSET_KEY)).toBe('120')
    expect(subtitleStyle).toHaveBeenCalledWith({ bottom: '120px' })
  })

  test('episode switch re-applies current size and offset', () => {
    window.localStorage.setItem(SIZE_KEY, '24')
    window.localStorage.setItem(OFFSET_KEY, '100')
    const { rerender } = render(
      <VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s1.vtt" danmakuList={[]} />,
    )
    rerender(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s2.vtt" danmakuList={[]} />)
    expect(subtitleSwitch).toHaveBeenCalledWith(
      '/s2.vtt',
      expect.objectContaining({
        style: { color: '#fff', fontSize: '24px', bottom: '100px' },
      }),
    )
  })
})

describe('VideoPlayer danmaku switching', () => {
  // Plugin's load(list) skips its internal reset branch; only load() with no args
  // clears the queue. So we must call config({ danmuku: list }) then load().
  test('switching danmakuList calls config + load() (no args) to clear old danmaku', () => {
    const list1 = [{ text: 'a', time: 1 }]
    const list2 = [{ text: 'b', time: 2 }]
    const { rerender } = render(
      <VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={list1} />,
    )
    expect(danmukuConfig).toHaveBeenLastCalledWith({ danmuku: list1 })
    expect(danmukuLoad).toHaveBeenLastCalledWith()

    rerender(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={list2} />)
    expect(danmukuConfig).toHaveBeenLastCalledWith({ danmuku: list2 })
    expect(danmukuLoad).toHaveBeenLastCalledWith()
    expect(danmukuLoad).toHaveBeenCalledTimes(2)
  })

  test('switching to empty list clears danmaku (does not short-circuit)', () => {
    const list1 = [{ text: 'a', time: 1 }]
    const { rerender } = render(
      <VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={list1} />,
    )
    danmukuConfig.mockClear()
    danmukuLoad.mockClear()

    rerender(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    expect(danmukuConfig).toHaveBeenCalledWith({ danmuku: [] })
    expect(danmukuLoad).toHaveBeenCalledTimes(1)
  })

  test('null danmakuList is normalized to empty array', () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={null} />)
    expect(danmukuConfig).toHaveBeenCalledWith({ danmuku: [] })
    expect(danmukuLoad).toHaveBeenCalledWith()
  })
})
