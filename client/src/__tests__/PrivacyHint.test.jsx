// @ts-check
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import PrivacyHint from '../components/shared/PrivacyHint.jsx';

describe('PrivacyHint', () => {
  it('renders the full reassurance copy by default', () => {
    render(<PrivacyHint />);
    const node = screen.getByTestId('privacy-hint');
    expect(node.textContent).toMatch(/文件存储在此设备/);
    expect(node.textContent).toMatch(/不上传服务器/);
  });

  it('renders compact copy when compact=true', () => {
    render(<PrivacyHint compact />);
    const node = screen.getByTestId('privacy-hint');
    expect(node.textContent).toMatch(/本地存储/);
    expect(node.textContent).toMatch(/不上传/);
    expect(node.textContent).not.toMatch(/服务器/);
  });

  it('renders a single dot indicator', () => {
    const { container } = render(<PrivacyHint />);
    // First child should be the pulsing dot span
    const dot = container.querySelector('[data-testid="privacy-hint"] > span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
  });
});
