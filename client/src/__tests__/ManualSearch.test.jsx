import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ManualSearch from '../components/player/ManualSearch';

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

describe('ManualSearch', () => {
  it('pre-fills the input with defaultKeyword', () => {
    render(<ManualSearch defaultKeyword="Naruto" onSelect={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByPlaceholderText('Search...').value).toBe('Naruto');
  });

  it('calls onBack when the back button is clicked', () => {
    const onBack = vi.fn();
    render(<ManualSearch defaultKeyword="" onSelect={vi.fn()} onBack={onBack} />);
    fireEvent.click(screen.getByText(/Back/));
    expect(onBack).toHaveBeenCalled();
  });

  it('does not trigger a search when the query is empty', () => {
    render(<ManualSearch defaultKeyword="" onSelect={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByText('Search'));
    expect(mockSearchAnime).not.toHaveBeenCalled();
  });

  it('runs a search and renders result rows', async () => {
    mockSearchAnime.mockResolvedValue({
      results: [
        {
          anilistId: 1,
          title: 'One Piece',
          titleChinese: '海贼王',
          coverImageUrl: 'https://example.com/op.jpg',
          seasonYear: 1999,
          format: 'TV',
          episodes: 1000,
          averageScore: 88,
        },
        {
          anilistId: 2,
          title: 'Bleach',
          imageUrl: 'https://example.com/bl.jpg',
          seasonYear: 2004,
        },
      ],
    });

    render(<ManualSearch defaultKeyword="one" onSelect={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByText('Search'));

    await waitFor(() => {
      expect(mockSearchAnime).toHaveBeenCalledWith('one');
    });
    expect(await screen.findByText('海贼王')).toBeInTheDocument();
    expect(screen.getByText('Bleach')).toBeInTheDocument();
  });

  it('submits the search on Enter key in the input', async () => {
    mockSearchAnime.mockResolvedValue({ results: [] });
    render(<ManualSearch defaultKeyword="" onSelect={vi.fn()} onBack={vi.fn()} />);

    const input = screen.getByPlaceholderText('Search...');
    await userEvent.type(input, 'bleach{Enter}');

    await waitFor(() => {
      expect(mockSearchAnime).toHaveBeenCalledWith('bleach');
    });
  });

  it('shows the empty-state after a search returns no results', async () => {
    mockSearchAnime.mockResolvedValue({ results: [] });
    render(<ManualSearch defaultKeyword="zzz" onSelect={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByText('Search'));

    expect(await screen.findByText('No results')).toBeInTheDocument();
  });

  it('treats API errors as empty results and still shows empty-state', async () => {
    mockSearchAnime.mockRejectedValue(new Error('network'));
    render(<ManualSearch defaultKeyword="x" onSelect={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByText('Search'));

    expect(await screen.findByText('No results')).toBeInTheDocument();
  });

  it('calls onSelect with the chosen item', async () => {
    const item = { anilistId: 99, title: 'Chosen' };
    mockSearchAnime.mockResolvedValue({ results: [item] });

    const onSelect = vi.fn();
    render(<ManualSearch defaultKeyword="c" onSelect={onSelect} onBack={vi.fn()} />);
    fireEvent.click(screen.getByText('Search'));

    const selectBtn = await screen.findByText('Select');
    fireEvent.click(selectBtn);

    expect(onSelect).toHaveBeenCalledWith(item);
  });

  it('disables the search button while a search is in flight', async () => {
    let resolve;
    mockSearchAnime.mockReturnValue(new Promise((r) => { resolve = r; }));

    render(<ManualSearch defaultKeyword="x" onSelect={vi.fn()} onBack={vi.fn()} />);
    const btn = screen.getByText('Search');
    fireEvent.click(btn);

    // While loading, the button shows '...' and is disabled
    expect(await screen.findByText('...')).toBeInTheDocument();
    expect(screen.getByText('...')).toBeDisabled();

    resolve({ results: [] });
    await waitFor(() => expect(screen.getByText('Search')).toBeEnabled());
  });
});
