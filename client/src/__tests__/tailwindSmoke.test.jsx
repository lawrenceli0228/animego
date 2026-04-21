import { render } from '@testing-library/react';

describe('Tailwind v4 smoke', () => {
  it('applies utility classes without crashing', () => {
    const { container } = render(
      <div className="bg-bg text-text rounded-md p-2" data-testid="tw-probe" />
    );
    const el = container.querySelector('[data-testid="tw-probe"]');
    expect(el).not.toBeNull();
    expect(el.className).toContain('bg-bg');
    expect(el.className).toContain('rounded-md');
  });
});
