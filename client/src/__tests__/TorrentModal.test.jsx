import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TorrentModal from '../components/anime/TorrentModal';

const mockUseTorrents = vi.fn();

vi.mock('../hooks/useAnime', () => ({
  useTorrents: (...args) => mockUseTorrents(...args),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'torrent.title': 'Torrents',
      'torrent.loading': 'Loading...',
      'torrent.noResults': 'No torrents',
      'torrent.groupAll': 'All groups',
      'torrent.placeholder': 'Search magnets',
      'torrent.searchBtn': 'Search',
      'torrent.epAll': 'All eps',
    }[key] || key),
  }),
}));

const baseAnime = {
  anilistId: 42,
  titleRomaji: 'Sample Anime',
  titleEnglish: 'Sample Anime',
  titleChinese: '样品动画',
  titleNative: 'サンプル',
  episodes: 3,
  coverImageUrl: 'https://example.com/x.jpg',
};

beforeEach(() => {
  mockUseTorrents.mockReset();
  mockUseTorrents.mockReturnValue({ data: [], isLoading: false });
});

describe('TorrentModal', () => {
  it('shows loading state when torrents are loading', () => {
    mockUseTorrents.mockReturnValue({ data: null, isLoading: true });
    render(<TorrentModal anime={baseAnime} onClose={vi.fn()} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows no-results state when torrent list is empty', () => {
    mockUseTorrents.mockReturnValue({ data: [], isLoading: false });
    render(<TorrentModal anime={baseAnime} onClose={vi.fn()} />);
    expect(screen.getByText('No torrents')).toBeInTheDocument();
  });

  it('renders torrent rows with parsed resolution and source tags', () => {
    mockUseTorrents.mockReturnValue({
      data: [
        {
          title: '[Group] Show - 01 [1080p][HEVC][WEB-DL].mkv',
          fansub: 'Group',
          magnet: 'magnet:?xt=1',
          size: '500 MB',
          date: '2025-01-15T00:00:00Z',
          source: 'nyaa',
        },
      ],
      isLoading: false,
    });
    render(<TorrentModal anime={baseAnime} onClose={vi.fn()} />);
    expect(screen.getByText(/\[Group\] Show - 01/)).toBeInTheDocument();
    expect(screen.getByText('1080P')).toBeInTheDocument();
    expect(screen.getByText('HEVC')).toBeInTheDocument();
    expect(screen.getByText('WEB-DL')).toBeInTheDocument();
    expect(screen.getByText('500 MB')).toBeInTheDocument();
    expect(screen.getByText('2025/01/15')).toBeInTheDocument();
    expect(screen.getByText('nyaa')).toBeInTheDocument();
  });

  it('renders "花园" label when source is dmhy', () => {
    mockUseTorrents.mockReturnValue({
      data: [{ title: '[X] S - 01.mkv', fansub: 'X', magnet: 'magnet:?xt=2', source: 'dmhy' }],
      isLoading: false,
    });
    render(<TorrentModal anime={baseAnime} onClose={vi.fn()} />);
    expect(screen.getByText('花园')).toBeInTheDocument();
  });

  it('copies magnet to clipboard and briefly shows confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });

    vi.useFakeTimers();
    mockUseTorrents.mockReturnValue({
      data: [{ title: 'T - 01', fansub: 'G', magnet: 'magnet:?xt=copyme' }],
      isLoading: false,
    });
    render(<TorrentModal anime={baseAnime} onClose={vi.fn()} />);

    const copyBtn = screen.getByTitle('Copy magnet');
    fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith('magnet:?xt=copyme');
    expect(screen.getByText('✓')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(2100); });
    expect(screen.queryByText('✓')).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it('opens magnet via window.open when open button clicked', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    mockUseTorrents.mockReturnValue({
      data: [{ title: 'T - 01', fansub: 'G', magnet: 'magnet:?xt=openme' }],
      isLoading: false,
    });
    render(<TorrentModal anime={baseAnime} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Open magnet'));
    expect(openSpy).toHaveBeenCalledWith('magnet:?xt=openme');
    openSpy.mockRestore();
  });

  it('closes on backdrop click and ignores clicks on inner panel', () => {
    const onClose = vi.fn();
    const { container } = render(<TorrentModal anime={baseAnime} onClose={onClose} />);
    fireEvent.click(container.firstChild);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Inner panel click should NOT bubble to close
    fireEvent.click(screen.getByText('Torrents').parentElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(<TorrentModal anime={baseAnime} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders title variant pills (deduped)', () => {
    render(<TorrentModal anime={baseAnime} onClose={vi.fn()} />);
    expect(screen.getByText('中文')).toBeInTheDocument();
    expect(screen.getByText('Romaji')).toBeInTheDocument();
    expect(screen.getByText('日本語')).toBeInTheDocument();
    // English dedupes because it equals Romaji
    expect(screen.queryByText('English')).not.toBeInTheDocument();
  });

  it('renders episode pills when anime has episodes', () => {
    render(<TorrentModal anime={baseAnime} onClose={vi.fn()} />);
    expect(screen.getByText('All eps')).toBeInTheDocument();
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('02')).toBeInTheDocument();
    expect(screen.getByText('03')).toBeInTheDocument();
  });

  it('builds fansub group list from torrent data', () => {
    mockUseTorrents.mockReturnValue({
      data: [
        { title: 'A', fansub: 'AlphaSub', magnet: 'm1' },
        { title: 'B', fansub: 'AlphaSub', magnet: 'm2' },
        { title: 'C', fansub: 'BetaSub', magnet: 'm3' },
      ],
      isLoading: false,
    });
    render(<TorrentModal anime={baseAnime} onClose={vi.fn()} />);
    expect(screen.getByText('AlphaSub')).toBeInTheDocument();
    expect(screen.getByText('BetaSub')).toBeInTheDocument();
  });

  it('updates searchQ on Enter in the search input', async () => {
    render(<TorrentModal anime={baseAnime} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search magnets');
    await userEvent.clear(input);
    await userEvent.type(input, 'new query{Enter}');
    // Last call receives the latest query
    const lastCall = mockUseTorrents.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('new query');
  });

  it('renders the cover image on the right panel', () => {
    render(<TorrentModal anime={baseAnime} onClose={vi.fn()} />);
    const img = screen.getByAltText('Sample Anime');
    expect(img).toHaveAttribute('src', 'https://example.com/x.jpg');
  });
});
