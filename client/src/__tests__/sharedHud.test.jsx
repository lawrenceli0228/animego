import { render } from '@testing-library/react';
import { SectionNum, SectionHeader, ChapterBar, CornerBrackets } from '../components/shared/hud';

describe('shared/hud — SectionNum', () => {
  it('renders the §0X marker text', () => {
    const { container } = render(<SectionNum n="01" />);
    expect(container.textContent).toBe('§01');
  });

  it('marks itself aria-hidden so screen readers skip the chapter chrome', () => {
    const { container } = render(<SectionNum n="07" />);
    const span = container.querySelector('span');
    expect(span).toBeTruthy();
    expect(span.getAttribute('aria-hidden')).toBe('true');
  });

  it('honors a custom style override', () => {
    const { container } = render(<SectionNum n="01" style={{ top: 10, fontSize: 9 }} />);
    const span = container.querySelector('span');
    expect(span.style.top).toBe('10px');
    expect(span.style.fontSize).toBe('9px');
  });
});

describe('shared/hud — SectionHeader', () => {
  it('renders eyebrow, title, and sub when all are provided', () => {
    const { getByText, container } = render(
      <SectionHeader eyebrow="LIVE //" title="Hello" sub="World" />
    );
    expect(getByText('LIVE //')).toBeInTheDocument();
    expect(getByText('Hello')).toBeInTheDocument();
    expect(getByText('World')).toBeInTheDocument();
    // Title is an h2 by default
    expect(container.querySelector('h2').textContent).toBe('Hello');
  });

  it('omits eyebrow / sub when not provided', () => {
    const { container } = render(<SectionHeader title="Solo" />);
    expect(container.querySelector('h2').textContent).toBe('Solo');
    expect(container.textContent).toBe('Solo');
  });

  it('threads titleId through for aria-labelledby wiring', () => {
    const { container } = render(<SectionHeader title="A" titleId="hud-h" />);
    expect(container.querySelector('h2').id).toBe('hud-h');
  });
});

describe('shared/hud — ChapterBar', () => {
  // trigger="mount" — player chrome usage. Avoids the inView code path which
  // depends on IntersectionObserver, not present in jsdom.
  it('renders an aria-hidden span at the requested position', () => {
    const { container } = render(
      <ChapterBar hue={210} height={48} top={12} left={20} trigger="mount" />
    );
    const bar = container.querySelector('span');
    expect(bar).toBeTruthy();
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(bar.style.top).toBe('12px');
    expect(bar.style.left).toBe('20px');
  });

  it('uses an OKLCH background derived from the requested hue', () => {
    const { container } = render(<ChapterBar hue={140} trigger="mount" />);
    const bar = container.querySelector('span');
    expect(bar.style.background).toMatch(/oklch\(.*140\)/);
  });

  it('flips origin to "left" when orientation="horizontal"', () => {
    const { container } = render(
      <ChapterBar hue={210} orientation="horizontal" trigger="mount" />
    );
    const bar = container.querySelector('span');
    expect(bar.style.transformOrigin).toBe('left');
  });
});

describe('shared/hud — CornerBrackets', () => {
  it('renders four SVG corners, each marked aria-hidden', () => {
    const { container } = render(
      <div style={{ position: 'relative' }}>
        <CornerBrackets />
      </div>
    );
    const corners = container.querySelectorAll('svg[aria-hidden="true"]');
    expect(corners.length).toBe(4);
  });

  it('positions the corners at top/left/bottom/right offsets matching `inset`', () => {
    const { container } = render(
      <div style={{ position: 'relative' }}>
        <CornerBrackets inset={10} size={12} />
      </div>
    );
    const corners = container.querySelectorAll('svg[aria-hidden="true"]');
    // Top-left: top + left set, bottom + right NOT set
    expect(corners[0].style.top).toBe('10px');
    expect(corners[0].style.left).toBe('10px');
    // Bottom-right: bottom + right set
    expect(corners[3].style.bottom).toBe('10px');
    expect(corners[3].style.right).toBe('10px');
  });

  it('uses an OKLCH stroke when a hue is provided', () => {
    const { container } = render(
      <div style={{ position: 'relative' }}>
        <CornerBrackets hue={195} opacity={0.4} />
      </div>
    );
    const path = container.querySelector('svg path');
    expect(path.getAttribute('stroke')).toMatch(/oklch\(.*195/);
  });
});
