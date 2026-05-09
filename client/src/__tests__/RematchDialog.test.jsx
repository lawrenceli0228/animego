// @ts-check
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RematchDialog from '../components/library/RematchDialog';

const mockSearchAnime = vi.fn();
vi.mock('../api/dandanplay.api', () => ({
  searchAnime: (...args) => mockSearchAnime(...args),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'player.back': 'Back',
      'player.manualHint': 'Search hint',
      'player.searchPlaceholder': 'Search...',
      'player.searchBtn': 'Search',
      'player.select': 'Select',
      'player.noResults': 'No results',
      'detail.epUnit': 'ep',
    }[key] || key),
  }),
}));

beforeEach(() => {
  mockSearchAnime.mockReset();
});

/** @param {Partial<import('../lib/library/types').Series>} overrides */
function makeSeries(overrides = {}) {
  return {
    id: 's-default',
    titleZh: '默认',
    titleEn: 'Default',
    type: 'tv',
    confidence: 0.6,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const SOURCE = makeSeries({ id: 'src-1', titleEn: 'Re:Zero' });

describe('RematchDialog', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <RematchDialog
        open={false}
        sourceSeries={SOURCE}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders backdrop + dialog when open=true', () => {
    render(
      <RematchDialog
        open
        sourceSeries={SOURCE}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('rematch-dialog-backdrop')).toBeInTheDocument();
    expect(screen.getByTestId('rematch-dialog')).toBeInTheDocument();
  });

  it('shows the source series title', () => {
    render(
      <RematchDialog
        open
        sourceSeries={SOURCE}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('rematch-source-title').textContent).toContain(
      'Re:Zero',
    );
  });

  it('pre-fills the search input with the source title', () => {
    render(
      <RematchDialog
        open
        sourceSeries={SOURCE}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const input = /** @type {HTMLInputElement} */ (
      screen.getByPlaceholderText('Search...')
    );
    expect(input.value).toBe('Re:Zero');
  });

  it('confirms with picked dandanplay item normalized to {animeId, titleZh, titleEn, posterUrl, type}', async () => {
    mockSearchAnime.mockResolvedValue({
      results: [
        {
          dandanAnimeId: 12345,
          title: 'Re:Zero kara',
          titleChinese: '从零开始',
          coverImageUrl: 'https://example.com/p.jpg',
          format: 'TV',
        },
      ],
    });

    const onConfirm = vi.fn();
    render(
      <RematchDialog
        open
        sourceSeries={SOURCE}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByText('Search'));
    const selectBtn = await screen.findByText('Select');
    fireEvent.click(selectBtn);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith({
      animeId: 12345,
      titleZh: '从零开始',
      titleEn: 'Re:Zero kara',
      posterUrl: 'https://example.com/p.jpg',
      type: 'tv',
    });
  });

  it('clicking the backdrop calls onClose', () => {
    const onClose = vi.fn();
    render(
      <RematchDialog
        open
        sourceSeries={SOURCE}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('rematch-dialog-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the dialog body does NOT call onClose', () => {
    const onClose = vi.fn();
    render(
      <RematchDialog
        open
        sourceSeries={SOURCE}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('rematch-dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape key calls onClose', () => {
    const onClose = vi.fn();
    render(
      <RematchDialog
        open
        sourceSeries={SOURCE}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <RematchDialog
        open
        sourceSeries={SOURCE}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('rematch-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('falls back to anilistId when dandanAnimeId is missing', async () => {
    mockSearchAnime.mockResolvedValue({
      results: [
        {
          anilistId: 9876,
          title: 'Some Anime',
          coverImageUrl: 'https://example.com/x.jpg',
        },
      ],
    });
    const onConfirm = vi.fn();
    render(
      <RematchDialog
        open
        sourceSeries={SOURCE}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText('Search'));
    const selectBtn = await screen.findByText('Select');
    fireEvent.click(selectBtn);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0][0].animeId).toBe(9876);
  });
});
