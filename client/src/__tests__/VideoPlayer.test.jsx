import { render, cleanup } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const ctorCalls = []
const instances = []
const subtitleStyle = vi.fn()
const subtitleSwitch = vi.fn()
const danmukuConfig = vi.fn()
const danmukuLoad = vi.fn()
const danmukuShow = vi.fn()
const danmukuHide = vi.fn()

function makeArtInstance(config) {
  ctorCalls.push(config)
  const handlers = {}
  const inst = {
    on: vi.fn((event, fn) => { handlers[event] = fn }),
    destroy: vi.fn(),
    subtitle: { style: subtitleStyle, switch: subtitleSwitch },
    plugins: {
      artplayerPluginDanmuku: {
        config: danmukuConfig,
        load: danmukuLoad,
        show: danmukuShow,
        hide: danmukuHide,
      },
    },
    currentTime: 0,
    duration: 1200,
    playbackRate: 1,
    handlers,
  }
  instances.push(inst)
  return inst
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
const RATE_KEY = 'animego:playbackRate'
const DANMAKU_VISIBLE_KEY = 'animego:danmakuVisible'

// The init effect awaits a dynamic import of artplayer-plugin-danmuku, so the
// Artplayer constructor only runs after a microtask flush. Tests that inspect
// constructor calls must await this helper after render/rerender.
async function flushAsync() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ctorCalls.length = 0
  instances.length = 0
  subtitleStyle.mockClear()
  subtitleSwitch.mockClear()
  danmukuConfig.mockClear()
  danmukuLoad.mockClear()
  danmukuShow.mockClear()
  danmukuHide.mockClear()
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('VideoPlayer subtitle slider settings', () => {
  test('uses defaults (20px size, 60px offset) when no preferences stored', async () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    expect(ctorCalls).toHaveLength(1)
    expect(ctorCalls[0].subtitle.style.fontSize).toBe('20px')
    expect(ctorCalls[0].subtitle.style.bottom).toBe('60px')
    const [sizeSetting, offsetSetting] = ctorCalls[0].settings
    expect(sizeSetting.tooltip).toBe('20px')
    expect(sizeSetting.range).toEqual([20, 14, 48, 2])
    expect(offsetSetting.tooltip).toBe('60px')
    expect(offsetSetting.range).toEqual([60, 10, 200, 5])
  })

  test('hydrates stored preferences into slider initial values', async () => {
    window.localStorage.setItem(SIZE_KEY, '32')
    window.localStorage.setItem(OFFSET_KEY, '140')
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    expect(ctorCalls[0].subtitle.style.fontSize).toBe('32px')
    expect(ctorCalls[0].subtitle.style.bottom).toBe('140px')
    expect(ctorCalls[0].settings[0].range[0]).toBe(32)
    expect(ctorCalls[0].settings[1].range[0]).toBe(140)
  })

  test('clamps out-of-range stored values into [min,max]', async () => {
    window.localStorage.setItem(SIZE_KEY, '999')
    window.localStorage.setItem(OFFSET_KEY, '-10')
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    expect(ctorCalls[0].subtitle.style.fontSize).toBe('48px')
    expect(ctorCalls[0].subtitle.style.bottom).toBe('10px')
  })

  test('size slider onChange persists and applies fontSize', async () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    const sizeSetting = ctorCalls[0].settings[0]
    const result = sizeSetting.onChange({ range: [28] })
    expect(result).toBe('28px')
    expect(window.localStorage.getItem(SIZE_KEY)).toBe('28')
    expect(subtitleStyle).toHaveBeenCalledWith({ fontSize: '28px' })
  })

  test('offset slider onChange persists and applies bottom', async () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    const offsetSetting = ctorCalls[0].settings[1]
    const result = offsetSetting.onChange({ range: [120] })
    expect(result).toBe('120px')
    expect(window.localStorage.getItem(OFFSET_KEY)).toBe('120')
    expect(subtitleStyle).toHaveBeenCalledWith({ bottom: '120px' })
  })

  test('episode switch re-applies current size and offset', async () => {
    window.localStorage.setItem(SIZE_KEY, '24')
    window.localStorage.setItem(OFFSET_KEY, '100')
    const { rerender } = render(
      <VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s1.vtt" danmakuList={[]} />,
    )
    await flushAsync()
    rerender(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s2.vtt" danmakuList={[]} />)
    await flushAsync()
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
  test('switching danmakuList calls config + load() (no args) to clear old danmaku', async () => {
    const list1 = [{ text: 'a', time: 1 }]
    const list2 = [{ text: 'b', time: 2 }]
    const { rerender } = render(
      <VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={list1} />,
    )
    await flushAsync()
    expect(danmukuConfig).toHaveBeenLastCalledWith({ danmuku: list1 })
    expect(danmukuLoad).toHaveBeenLastCalledWith()

    rerender(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={list2} />)
    await flushAsync()
    expect(danmukuConfig).toHaveBeenLastCalledWith({ danmuku: list2 })
    expect(danmukuLoad).toHaveBeenLastCalledWith()
    expect(danmukuLoad).toHaveBeenCalledTimes(2)
  })

  test('switching to empty list clears danmaku (does not short-circuit)', async () => {
    const list1 = [{ text: 'a', time: 1 }]
    const { rerender } = render(
      <VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={list1} />,
    )
    await flushAsync()
    danmukuConfig.mockClear()
    danmukuLoad.mockClear()

    rerender(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    expect(danmukuConfig).toHaveBeenCalledWith({ danmuku: [] })
    expect(danmukuLoad).toHaveBeenCalledTimes(1)
  })

  test('null danmakuList is normalized to empty array', async () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={null} />)
    await flushAsync()
    expect(danmukuConfig).toHaveBeenCalledWith({ danmuku: [] })
    expect(danmukuLoad).toHaveBeenCalledWith()
  })
})

describe('VideoPlayer playback rate setting', () => {
  test('passes playbackRate: false to disable artplayer built-in rate UI', async () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    // artplayer 5.x: option.playbackRate is a boolean flag, not the rate value.
    // We pass false so artplayer does not surface its built-in rate UI; our
    // custom selector replaces it.
    expect(ctorCalls[0].playbackRate).toBe(false)
  })

  test('uses default 1.0x in selector when no preference stored', async () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    const rateSetting = ctorCalls[0].settings[2]
    expect(rateSetting.html).toBe('倍速')
    expect(rateSetting.tooltip).toBe('1x')
    expect(rateSetting.selector).toHaveLength(6)
    expect(rateSetting.selector.find((o) => o.default).value).toBe(1.0)
  })

  test('hydrates stored playback rate into selector default', async () => {
    window.localStorage.setItem(RATE_KEY, '1.5')
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    const rateSetting = ctorCalls[0].settings[2]
    expect(rateSetting.tooltip).toBe('1.5x')
    expect(rateSetting.selector.find((o) => o.default).value).toBe(1.5)
  })

  test('applies stored rate to instance after video:loadedmetadata fires', async () => {
    window.localStorage.setItem(RATE_KEY, '1.5')
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    const inst = instances[0]
    expect(inst.handlers['video:loadedmetadata']).toBeTypeOf('function')
    expect(inst.playbackRate).toBe(1) // not yet applied
    inst.handlers['video:loadedmetadata']()
    expect(inst.playbackRate).toBe(1.5)
  })

  test('falls back to 1.0x in selector when stored rate is not in option list', async () => {
    window.localStorage.setItem(RATE_KEY, '3.0')
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    const rateSetting = ctorCalls[0].settings[2]
    expect(rateSetting.selector.find((o) => o.default).value).toBe(1.0)
  })

  test('onSelect persists and returns formatted tooltip', async () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    const rateSetting = ctorCalls[0].settings[2]
    const result = rateSetting.onSelect({ value: 1.25 })
    expect(result).toBe('1.25x')
    expect(window.localStorage.getItem(RATE_KEY)).toBe('1.25')
  })
})

describe('VideoPlayer danmaku visibility setting', () => {
  test('defaults to visible (switch=true) when no preference stored', async () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    const switchSetting = ctorCalls[0].settings[3]
    expect(switchSetting.html).toBe('弹幕开关')
    expect(switchSetting.switch).toBe(true)
    expect(switchSetting.tooltip).toBe('开')
    // Visible by default — plugin should NOT have been hidden on init.
    expect(danmukuHide).not.toHaveBeenCalled()
  })

  test('hides danmaku on init when stored preference is "0"', async () => {
    window.localStorage.setItem(DANMAKU_VISIBLE_KEY, '0')
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    const switchSetting = ctorCalls[0].settings[3]
    expect(switchSetting.switch).toBe(false)
    expect(switchSetting.tooltip).toBe('关')
    expect(danmukuHide).toHaveBeenCalledTimes(1)
  })

  test('onSwitch toggles plugin visibility and persists', async () => {
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[]} />)
    await flushAsync()
    const switchSetting = ctorCalls[0].settings[3]
    // current switch=true -> turning OFF
    const offResult = switchSetting.onSwitch({ switch: true })
    expect(offResult).toBe(false)
    expect(window.localStorage.getItem(DANMAKU_VISIBLE_KEY)).toBe('0')
    expect(danmukuHide).toHaveBeenCalledTimes(1)
    // turning back ON
    const onResult = switchSetting.onSwitch({ switch: false })
    expect(onResult).toBe(true)
    expect(window.localStorage.getItem(DANMAKU_VISIBLE_KEY)).toBe('1')
    expect(danmukuShow).toHaveBeenCalledTimes(1)
  })
})

describe('VideoPlayer danmaku plugin tuning', () => {
  test('passes maxLength=60 and synchronousPlayback=false to plugin factory', async () => {
    const { default: pluginFactory } = await import('artplayer-plugin-danmuku')
    pluginFactory.mockClear()
    render(<VideoPlayer videoUrl="/v.mp4" subtitleUrl="/s.vtt" danmakuList={[{ text: 'a', time: 1 }]} />)
    await flushAsync()
    expect(pluginFactory).toHaveBeenCalledTimes(1)
    expect(pluginFactory.mock.calls[0][0]).toMatchObject({
      maxLength: 60,
      synchronousPlayback: false,
      antiOverlap: true,
      emitter: false,
    })
  })
})
