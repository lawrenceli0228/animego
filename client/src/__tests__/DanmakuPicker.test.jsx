import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import DanmakuPicker from '../components/player/DanmakuPicker';

const mockSearchAnime = vi.fn();
const mockGetEpisodes = vi.fn();

vi.mock('../api/dandanplay.api', () => ({
  searchAnime: (...args) => mockSearchAnime(...args),
  getEpisodes: (...args) => mockGetEpisodes(...args),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'player.setDanmaku': 'Set Danmaku',
      'player.currentAnime': 'Current Anime',
      'player.searchOther': 'Search Other',
      'player.searchPlaceholder': 'Search...',
      'player.searchBtn': 'Search',
      'player.noResults': 'No results',
      'player.loadingEpisodes': 'Loading episodes...',
      'player.noEpisodesFound': 'No episodes found',
      'player.currentMatch': 'current match',
      'player.confirmDanmaku': 'Confirm',
    }[key] || key),
  }),
}));

beforeEach(() => {
  mockSearchAnime.mockReset();
  mockGetEpisodes.mockReset();
});

const currentAnime = {
  dandanAnimeId: 100,
  bgmId: 'bgm-200',
  titleChinese: '当前番剧',
  titleNative: 'Current Show',
};

function makeProps(overrides = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    currentAnime,
    currentEpisodeId: 1001,
    episodeNumber: 3,
    defaultKeyword: '',
    ...overrides,
  };
}

describe('DanmakuPicker — closed state', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = render(<DanmakuPicker {...makeProps({ isOpen: false })} />);
    expect(container.firstChild).toBeNull();
    expect(mockGetEpisodes).not.toHaveBeenCalled();
    expect(mockSearchAnime).not.toHaveBeenCalled();
  });
});

describe('DanmakuPicker — header & dismiss', () => {
  it('renders padded episode number and Chinese title in header', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
    render(<DanmakuPicker {...makeProps({ episodeNumber: 3 })} />);
    expect(screen.getByText(/EP03/)).toBeInTheDocument();
    expect(screen.getByText('当前番剧')).toBeInTheDocument();
  });

  it('calls onClose when ✕ button is clicked', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
    const onClose = vi.fn();
    render(<DanmakuPicker {...makeProps({ onClose })} />);
    fireEvent.click(screen.getByText('✕'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when overlay (outside modal) is clicked', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
    const onClose = vi.fn();
    const { container } = render(<DanmakuPicker {...makeProps({ onClose })} />);
    fireEvent.click(container.firstChild);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not call onClose when modal interior is clicked', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
    const onClose = vi.fn();
    render(<DanmakuPicker {...makeProps({ onClose })} />);
    fireEvent.click(screen.getByText(/EP03/));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when Escape key is pressed', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
    const onClose = vi.fn();
    render(<DanmakuPicker {...makeProps({ onClose })} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('removes the Escape listener after close (no leak)', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
    const onClose = vi.fn();
    const { rerender } = render(<DanmakuPicker {...makeProps({ onClose })} />);
    rerender(<DanmakuPicker {...makeProps({ onClose, isOpen: false })} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('DanmakuPicker — tabs', () => {
  it('hides the Current Anime tab when no current anime is provided', async () => {
    mockSearchAnime.mockResolvedValue({ results: [] });
    render(<DanmakuPicker {...makeProps({ currentAnime: null, defaultKeyword: 'kw' })} />);
    expect(screen.queryByText('Current Anime')).not.toBeInTheDocument();
    expect(screen.getByText('Search Other')).toBeInTheDocument();
  });

  it('starts on the Current Anime tab when a current anime exists', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
    render(<DanmakuPicker {...makeProps()} />);
    await waitFor(() => expect(mockGetEpisodes).toHaveBeenCalledWith(100, 'bgm-200'));
  });

  it('switches to the Search tab when user clicks it', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
    render(<DanmakuPicker {...makeProps()} />);
    fireEvent.click(screen.getByText('Search Other'));
    expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
  });
});

describe('DanmakuPicker — auto-load on open', () => {
  it('loads episodes for currentAnime on open', async () => {
    mockGetEpisodes.mockResolvedValue({
      episodes: [{ dandanEpisodeId: 1001, number: 1, title: 'First' }],
    });
    render(<DanmakuPicker {...makeProps()} />);
    expect(await screen.findByText('First')).toBeInTheDocument();
  });

  it('auto-searches with defaultKeyword on open', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
    mockSearchAnime.mockResolvedValue({ results: [] });
    render(<DanmakuPicker {...makeProps({ defaultKeyword: 'naruto' })} />);
    await waitFor(() => expect(mockSearchAnime).toHaveBeenCalledWith('naruto'));
  });

  it('falls back to currentAnime.titleNative when defaultKeyword is empty', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
    mockSearchAnime.mockResolvedValue({ results: [] });
    render(<DanmakuPicker {...makeProps({ defaultKeyword: '' })} />);
    await waitFor(() => expect(mockSearchAnime).toHaveBeenCalledWith('Current Show'));
  });

  it('skips auto-search when no keyword is inferable', async () => {
    render(<DanmakuPicker {...makeProps({ currentAnime: null, defaultKeyword: '' })} />);
    expect(mockSearchAnime).not.toHaveBeenCalled();
  });

  it('resets state when re-opened (no stale selection from prior open)', async () => {
    mockGetEpisodes.mockResolvedValue({
      episodes: [{ dandanEpisodeId: 9, number: 1, title: 'Ep1' }],
    });
    const { rerender } = render(<DanmakuPicker {...makeProps()} />);
    await screen.findByText('Ep1');
    fireEvent.click(screen.getByText('Ep1'));
    expect(screen.getByText('Confirm')).toBeInTheDocument();

    rerender(<DanmakuPicker {...makeProps({ isOpen: false })} />);
    rerender(<DanmakuPicker {...makeProps({ isOpen: true })} />);
    await screen.findByText('Ep1');
    expect(screen.queryByText('Confirm')).not.toBeInTheDocument();
  });
});

describe('DanmakuPicker — current anime episode list', () => {
  it('renders episodes with padded EP labels', async () => {
    mockGetEpisodes.mockResolvedValue({
      episodes: [
        { dandanEpisodeId: 1, number: 1, title: 'Pilot' },
        { dandanEpisodeId: 2, number: 12, title: 'Finale' },
      ],
    });
    render(<DanmakuPicker {...makeProps()} />);
    expect(await screen.findByText('EP01')).toBeInTheDocument();
    expect(screen.getByText('EP12')).toBeInTheDocument();
  });

  it('falls back to rawEpisodeNumber when number is missing', async () => {
    mockGetEpisodes.mockResolvedValue({
      episodes: [{ dandanEpisodeId: 1, number: null, rawEpisodeNumber: 'OVA1', title: 'Special' }],
    });
    render(<DanmakuPicker {...makeProps()} />);
    expect(await screen.findByText('OVA1')).toBeInTheDocument();
  });

  it('marks the matching dandanEpisodeId with the current-match badge', async () => {
    mockGetEpisodes.mockResolvedValue({
      episodes: [
        { dandanEpisodeId: 1001, number: 1, title: 'Match' },
        { dandanEpisodeId: 1002, number: 2, title: 'NotMatch' },
      ],
    });
    render(<DanmakuPicker {...makeProps({ currentEpisodeId: 1001 })} />);
    await screen.findByText('Match');
    expect(screen.getByText('current match')).toBeInTheDocument();
  });

  it('shows loading text while episodes are being fetched', async () => {
    let resolveFn;
    mockGetEpisodes.mockReturnValue(new Promise((r) => { resolveFn = r; }));
    render(<DanmakuPicker {...makeProps()} />);
    expect(screen.getByText('Loading episodes...')).toBeInTheDocument();
    await act(async () => { resolveFn({ episodes: [] }); });
  });

  it('shows empty state when no episodes are returned', async () => {
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
    render(<DanmakuPicker {...makeProps()} />);
    expect(await screen.findByText('No episodes found')).toBeInTheDocument();
  });

  it('falls back to empty episodes when getEpisodes throws', async () => {
    mockGetEpisodes.mockRejectedValue(new Error('boom'));
    render(<DanmakuPicker {...makeProps()} />);
    expect(await screen.findByText('No episodes found')).toBeInTheDocument();
  });
});

describe('DanmakuPicker — search tab', () => {
  it('runs search when the Search button is clicked', async () => {
    mockSearchAnime.mockResolvedValue({ results: [] });
    render(<DanmakuPicker {...makeProps({ currentAnime: null, defaultKeyword: '' })} />);

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'one' } });
    fireEvent.click(screen.getByText('Search'));
    await waitFor(() => expect(mockSearchAnime).toHaveBeenCalledWith('one'));
  });

  it('triggers search on Enter key in the input', async () => {
    mockSearchAnime.mockResolvedValue({ results: [] });
    render(<DanmakuPicker {...makeProps({ currentAnime: null, defaultKeyword: '' })} />);
    const input = screen.getByPlaceholderText('Search...');
    fireEvent.change(input, { target: { value: 'bleach' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mockSearchAnime).toHaveBeenCalledWith('bleach'));
  });

  it('does not search when the query is whitespace-only', async () => {
    render(<DanmakuPicker {...makeProps({ currentAnime: null, defaultKeyword: '' })} />);
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Search'));
    expect(mockSearchAnime).not.toHaveBeenCalled();
  });

  it('renders search results after fetch resolves', async () => {
    mockSearchAnime.mockResolvedValue({
      results: [
        { anilistId: 1, title: 'One Piece', titleChinese: '海贼王', seasonYear: 1999, format: 'TV', episodes: 1000 },
        { anilistId: 2, title: 'Bleach', seasonYear: 2004 },
      ],
    });
    render(<DanmakuPicker {...makeProps({ currentAnime: null, defaultKeyword: 'pirate' })} />);
    expect(await screen.findByText('海贼王')).toBeInTheDocument();
    expect(screen.getByText('Bleach')).toBeInTheDocument();
  });

  it('shows the empty state after a search returns no results', async () => {
    mockSearchAnime.mockResolvedValue({ results: [] });
    render(<DanmakuPicker {...makeProps({ currentAnime: null, defaultKeyword: 'nothing' })} />);
    expect(await screen.findByText('No results')).toBeInTheDocument();
  });

  it('falls back to empty results when searchAnime throws', async () => {
    mockSearchAnime.mockRejectedValue(new Error('net'));
    render(<DanmakuPicker {...makeProps({ currentAnime: null, defaultKeyword: 'kw' })} />);
    expect(await screen.findByText('No results')).toBeInTheDocument();
  });
});

describe('DanmakuPicker — pick anime then back', () => {
  it('loads picked anime episodes when a search result is clicked', async () => {
    mockSearchAnime.mockResolvedValue({
      results: [{ anilistId: 1, dandanAnimeId: 555, bgmId: 'bgm-555', title: 'Picked' }],
    });
    mockGetEpisodes.mockResolvedValue({
      episodes: [{ dandanEpisodeId: 9, number: 1, title: 'PickedEp' }],
    });
    render(<DanmakuPicker {...makeProps({ currentAnime: null, defaultKeyword: 'q' })} />);
    fireEvent.click(await screen.findByText('Picked'));
    await waitFor(() => expect(mockGetEpisodes).toHaveBeenCalledWith(555, 'bgm-555'));
    expect(await screen.findByText('PickedEp')).toBeInTheDocument();
  });

  it('returns to search results when ← back is clicked', async () => {
    mockSearchAnime.mockResolvedValue({
      results: [{ anilistId: 1, dandanAnimeId: 555, title: 'Picked' }],
    });
    mockGetEpisodes.mockResolvedValue({
      episodes: [{ dandanEpisodeId: 9, number: 1, title: 'PickedEp' }],
    });
    render(<DanmakuPicker {...makeProps({ currentAnime: null, defaultKeyword: 'q' })} />);
    fireEvent.click(await screen.findByText('Picked'));
    await screen.findByText('PickedEp');
    fireEvent.click(screen.getByText('←'));
    expect(screen.getByText('Picked')).toBeInTheDocument();
    expect(screen.queryByText('PickedEp')).not.toBeInTheDocument();
  });
});

describe('DanmakuPicker — confirm', () => {
  it('does not show Confirm until an episode is selected', async () => {
    mockGetEpisodes.mockResolvedValue({
      episodes: [{ dandanEpisodeId: 1, number: 1, title: 'Ep1' }],
    });
    render(<DanmakuPicker {...makeProps()} />);
    await screen.findByText('Ep1');
    expect(screen.queryByText('Confirm')).not.toBeInTheDocument();
  });

  it('fires onConfirm with current-tab selection (no pickedAnime)', async () => {
    mockGetEpisodes.mockResolvedValue({
      episodes: [{ dandanEpisodeId: 42, number: 7, title: 'Ep7' }],
    });
    const onConfirm = vi.fn();
    render(<DanmakuPicker {...makeProps({ onConfirm })} />);
    fireEvent.click(await screen.findByText('Ep7'));
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledWith(
      { dandanEpisodeId: 42, title: 'Ep7' },
      null,
    );
  });

  it('fires onConfirm with the picked anime when going through search', async () => {
    mockSearchAnime.mockResolvedValue({
      results: [{ anilistId: 1, dandanAnimeId: 555, title: 'Picked' }],
    });
    mockGetEpisodes.mockResolvedValue({
      episodes: [{ dandanEpisodeId: 77, number: 1, title: 'PickedEp' }],
    });
    const onConfirm = vi.fn();
    render(<DanmakuPicker {...makeProps({ currentAnime: null, defaultKeyword: 'q', onConfirm })} />);
    fireEvent.click(await screen.findByText('Picked'));
    fireEvent.click(await screen.findByText('PickedEp'));
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledWith(
      { dandanEpisodeId: 77, title: 'PickedEp' },
      expect.objectContaining({ dandanAnimeId: 555 }),
    );
  });
});
