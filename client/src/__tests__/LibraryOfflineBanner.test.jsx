// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LibraryOfflineBanner from '../components/library/LibraryOfflineBanner';

function rec(libraryId, name) {
  return { id: 'r-' + libraryId, libraryId, name, handle: {}, addedAt: 0, lastSeenAt: 0 };
}

describe('LibraryOfflineBanner', () => {
  it('renders nothing when no offline libraries', () => {
    const { container } = render(
      <LibraryOfflineBanner roots={[]} offlineLibraryIds={[]} onRetry={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders single-drive banner with name in title', () => {
    render(
      <LibraryOfflineBanner
        roots={[rec('lib-A', 'usb-anime')]}
        offlineLibraryIds={['lib-A']}
        onRetry={vi.fn()}
      />,
    );
    const banner = screen.getByTestId('library-offline-banner');
    expect(banner.getAttribute('data-count')).toBe('1');
    expect(banner.textContent).toMatch(/usb-anime/);
    expect(banner.textContent).toMatch(/未连接/);
  });

  it('renders multi-drive banner with count', () => {
    render(
      <LibraryOfflineBanner
        roots={[rec('lib-A', 'a'), rec('lib-B', 'b')]}
        offlineLibraryIds={['lib-A', 'lib-B']}
        onRetry={vi.fn()}
      />,
    );
    const banner = screen.getByTestId('library-offline-banner');
    expect(banner.getAttribute('data-count')).toBe('2');
    expect(banner.textContent).toMatch(/2 个硬盘未连接/);
  });

  it('retry button fires onRetry', () => {
    const onRetry = vi.fn();
    render(
      <LibraryOfflineBanner
        roots={[rec('lib-A', 'a')]}
        offlineLibraryIds={['lib-A']}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByTestId('library-offline-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
