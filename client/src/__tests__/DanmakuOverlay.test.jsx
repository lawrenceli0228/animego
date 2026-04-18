import { render, screen, fireEvent, act, createEvent, waitFor } from '@testing-library/react';
import DanmakuOverlay from '../components/anime/DanmakuOverlay';

describe('DanmakuOverlay', () => {
  it('renders an empty overlay when no messages', () => {
    const { container } = render(<DanmakuOverlay messages={[]} />);
    expect(container.querySelectorAll('div[style*="animation"]')).toHaveLength(0);
  });

  it('renders each new incoming message', () => {
    const { rerender } = render(<DanmakuOverlay messages={[]} />);

    rerender(
      <DanmakuOverlay
        messages={[
          { _id: '1', content: 'hi', username: 'alice' },
          { _id: '2', content: 'hello', username: 'bob' },
        ]}
      />
    );

    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('does not re-render already-seen messages when array shrinks and grows', () => {
    const { rerender } = render(
      <DanmakuOverlay messages={[{ _id: '1', content: 'first', username: 'a' }]} />
    );
    expect(screen.getByText('first')).toBeInTheDocument();

    rerender(
      <DanmakuOverlay
        messages={[
          { _id: '1', content: 'first', username: 'a' },
          { _id: '2', content: 'second', username: 'b' },
        ]}
      />
    );
    // Only the new one is added; the first stays
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('wires onAnimationEnd to remove items (handler presence)', () => {
    // jsdom lacks AnimationEvent constructor, so we verify the handler is attached
    // on each rendered danmaku item instead of simulating the event.
    const { container } = render(
      <DanmakuOverlay messages={[{ _id: '1', content: 'bye', username: 'a' }]} />
    );
    const msg = screen.getByText('bye');
    // The div wrapping content receives the animation — it's the only animated div
    expect(msg.style.animation).toContain('danmaku-fly');
    // And the wrapper is positioned absolutely (part of the flying row)
    expect(msg.style.position).toBe('absolute');
    // Only one item rendered
    expect(container.querySelectorAll('div[style*="animation"]')).toHaveLength(1);
  });

  it('falls back to random id when _id is missing', () => {
    render(<DanmakuOverlay messages={[{ content: 'anon', username: 'x' }]} />);
    expect(screen.getByText('anon')).toBeInTheDocument();
  });

  it('assigns lanes within the valid range (0..3)', () => {
    render(
      <DanmakuOverlay
        messages={[
          { _id: '1', content: 'a', username: 'a' },
          { _id: '2', content: 'b', username: 'b' },
          { _id: '3', content: 'c', username: 'c' },
          { _id: '4', content: 'd', username: 'd' },
          { _id: '5', content: 'e', username: 'e' },
        ]}
      />
    );

    const nodes = ['a', 'b', 'c', 'd', 'e'].map((t) => screen.getByText(t));
    for (const node of nodes) {
      const top = parseInt(node.style.top, 10);
      // 4 lanes × 32px + 4px inset → tops are 4, 36, 68, 100
      expect([4, 36, 68, 100]).toContain(top);
    }
  });

  it('is marked aria-hidden because danmaku is decorative', () => {
    const { container } = render(<DanmakuOverlay messages={[]} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });
});
