import { render } from '@testing-library/react';
import LoadingSpinner from '../components/common/LoadingSpinner';

describe('LoadingSpinner', () => {
  it('renders a spinner element', () => {
    const { container } = render(<LoadingSpinner />);
    const spinner = container.querySelector('div[style*="animation"]');
    expect(spinner).toBeInTheDocument();
    expect(spinner.style.borderRadius).toBe('50%');
  });

  it('uses a centered wrapper', () => {
    const { container } = render(<LoadingSpinner />);
    const wrap = container.firstChild;
    expect(wrap.style.display).toBe('flex');
    expect(wrap.style.justifyContent).toBe('center');
    expect(wrap.style.alignItems).toBe('center');
  });
});
