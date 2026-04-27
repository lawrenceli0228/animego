import { render, screen, act } from '@testing-library/react';
import { vi } from 'vitest';

// Replace the heavy VideoPlayer (drives artplayer) with a stub. The HUD frame's
// only contract with VideoPlayer is prop forwarding — we verify that, not the
// engine itself.
const videoPlayerStub = vi.fn();
vi.mock('../components/player/VideoPlayer', () => ({
  default: (props) => {
    videoPlayerStub(props);
    return (
      <div
        data-testid="video-player-stub"
        data-video-url={props.videoUrl || ''}
        data-progress-key={props.progressKey || ''}
        data-subtitle-url={props.subtitleUrl || ''}
        data-danmaku-count={Array.isArray(props.danmakuList) ? props.danmakuList.length : 0}
      />
    );
  },
}));

const reducedMotionRef = { current: false };
vi.mock('motion/react', async () => {
  const actual = await vi.importActual('motion/react');
  return { ...actual, useReducedMotion: () => reducedMotionRef.current };
});

import PlayerHudFrame from '../components/player/PlayerHudFrame';

describe('PlayerHudFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    videoPlayerStub.mockClear();
    reducedMotionRef.current = false;
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders the VideoPlayer stub and forwards key props', () => {
    render(
      <PlayerHudFrame
        videoUrl="blob:vid-1"
        danmakuList={[{ text: 'a' }, { text: 'b' }]}
        subtitleUrl="blob:sub-1"
        onEnded={() => {}}
        progressKey="animego:progress:1:7"
        episode={7}
        danmakuCount={1234}
      />
    );
    const stub = screen.getByTestId('video-player-stub');
    expect(stub.getAttribute('data-video-url')).toBe('blob:vid-1');
    expect(stub.getAttribute('data-progress-key')).toBe('animego:progress:1:7');
    expect(stub.getAttribute('data-subtitle-url')).toBe('blob:sub-1');
    expect(stub.getAttribute('data-danmaku-count')).toBe('2');
  });

  it('renders a status strip that types out the STREAM identity over time', () => {
    const { container } = render(
      <PlayerHudFrame
        videoUrl="vid"
        danmakuList={[]}
        subtitleUrl=""
        onEnded={() => {}}
        progressKey="key"
        episode={3}
        danmakuCount={42}
        quality="1080p"
      />
    );
    // Initially typed text is empty (chars haven't ticked in yet).
    expect(container.textContent).toContain('// EP 03 //');

    // Drive the type-on interval to completion.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.textContent).toContain('STREAM // 42 COMMENTS // 1080p');
  });

  it('renders the EP callsign in the lower-right corner', () => {
    render(
      <PlayerHudFrame
        videoUrl="vid"
        danmakuList={[]}
        subtitleUrl=""
        onEnded={() => {}}
        progressKey="key"
        episode={12}
      />
    );
    // Callsign uses padded ep number
    expect(document.body.textContent).toContain('// EP 12 //');
  });

  it('falls back to "--" when episode is null', () => {
    render(
      <PlayerHudFrame
        videoUrl="vid"
        danmakuList={[]}
        subtitleUrl=""
        onEnded={() => {}}
        progressKey="key"
        episode={null}
      />
    );
    expect(document.body.textContent).toContain('// EP -- //');
  });

  it('renders four corner brackets around the player slot', () => {
    const { container } = render(
      <PlayerHudFrame
        videoUrl="vid"
        danmakuList={[]}
        subtitleUrl=""
        onEnded={() => {}}
        progressKey="key"
        episode={1}
      />
    );
    const corners = container.querySelectorAll('svg[aria-hidden="true"]');
    expect(corners.length).toBeGreaterThanOrEqual(4);
  });

  it('forwards onEnded callback by reference to the underlying VideoPlayer', () => {
    const onEnded = vi.fn();
    render(
      <PlayerHudFrame
        videoUrl="vid"
        danmakuList={[]}
        subtitleUrl=""
        onEnded={onEnded}
        progressKey="key"
        episode={1}
      />
    );
    expect(videoPlayerStub).toHaveBeenCalled();
    const props = videoPlayerStub.mock.calls[0][0];
    expect(props.onEnded).toBe(onEnded);
  });

  it('skips the type-on interval entirely when prefers-reduced-motion is set', () => {
    reducedMotionRef.current = true;
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const { container } = render(
      <PlayerHudFrame
        videoUrl="vid"
        danmakuList={[]}
        subtitleUrl=""
        onEnded={() => {}}
        progressKey="key"
        episode={5}
        danmakuCount={9}
        quality="720p"
      />
    );
    // Full text appears immediately, with no interval scheduled.
    expect(container.textContent).toContain('STREAM // 9 COMMENTS // 720p');
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('clears the type-on interval on unmount (no leaked timers)', () => {
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const { unmount } = render(
      <PlayerHudFrame
        videoUrl="vid"
        danmakuList={[]}
        subtitleUrl=""
        onEnded={() => {}}
        progressKey="key"
        episode={1}
        danmakuCount={1}
      />
    );
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
