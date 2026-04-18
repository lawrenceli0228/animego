import { render, screen } from '@testing-library/react';
import DanmakuSection from '../components/anime/DanmakuSection';

const mockUseAuth = vi.fn();
const mockUseDanmakuHistory = vi.fn();
const mockUseDanmakuSocket = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'danmaku.label': 'DANMAKU',
      'danmaku.live': 'LIVE',
      'danmaku.windowClosed': 'Window closed',
    }[key] || key),
  }),
}));

vi.mock('../hooks/useDanmaku', () => ({
  useDanmakuHistory: (...args) => mockUseDanmakuHistory(...args),
  useDanmakuSocket: (...args) => mockUseDanmakuSocket(...args),
}));

vi.mock('../components/anime/DanmakuOverlay', () => ({
  default: ({ messages }) => (
    <div data-testid="overlay">overlay:{messages.length}</div>
  ),
}));

vi.mock('../components/anime/DanmakuInput', () => ({
  default: ({ connected }) => (
    <div data-testid="input">input:{connected ? 'on' : 'off'}</div>
  ),
}));

beforeEach(() => {
  mockUseAuth.mockReset();
  mockUseDanmakuHistory.mockReset();
  mockUseDanmakuSocket.mockReset();
  mockUseAuth.mockReturnValue({ user: { username: 'alice' } });
  mockUseDanmakuSocket.mockReturnValue({ live: [], connected: true, send: vi.fn() });
});

describe('DanmakuSection', () => {
  it('renders label and passes history messages to overlay', () => {
    mockUseDanmakuHistory.mockReturnValue({
      data: { data: [{ _id: '1' }, { _id: '2' }], liveEndsAt: null },
    });
    render(<DanmakuSection anilistId={42} episode={1} />);
    expect(screen.getByText('DANMAKU')).toBeInTheDocument();
    expect(screen.getByTestId('overlay')).toHaveTextContent('overlay:2');
  });

  it('shows total count next to the label when messages exist', () => {
    mockUseDanmakuHistory.mockReturnValue({
      data: { data: [{ _id: '1' }], liveEndsAt: null },
    });
    render(<DanmakuSection anilistId={1} episode={1} />);
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('does not show count when there are no messages', () => {
    mockUseDanmakuHistory.mockReturnValue({
      data: { data: [], liveEndsAt: null },
    });
    const { container } = render(<DanmakuSection anilistId={1} episode={1} />);
    // The count span (fontSize: 11) is only rendered when allMessages.length > 0
    const spans = container.querySelectorAll('span');
    // LIVE badge won't be rendered either (no liveEndsAt)
    expect(spans.length).toBe(0);
  });

  it('shows the LIVE badge when liveEndsAt is in the future', () => {
    mockUseDanmakuHistory.mockReturnValue({
      data: {
        data: [],
        liveEndsAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    render(<DanmakuSection anilistId={1} episode={1} />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('hides the LIVE badge and shows "window closed" when liveEndsAt is past', () => {
    mockUseDanmakuHistory.mockReturnValue({
      data: {
        data: [{ _id: '1' }],
        liveEndsAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    render(<DanmakuSection anilistId={1} episode={1} />);
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
    expect(screen.getByText('Window closed')).toBeInTheDocument();
    expect(screen.queryByTestId('input')).not.toBeInTheDocument();
  });

  it('renders the input when the window has not been started yet', () => {
    mockUseDanmakuHistory.mockReturnValue({
      data: { data: [], liveEndsAt: null },
    });
    render(<DanmakuSection anilistId={1} episode={1} />);
    expect(screen.getByTestId('input')).toBeInTheDocument();
  });

  it('dedupes live messages that already appear in history', () => {
    mockUseDanmakuHistory.mockReturnValue({
      data: {
        data: [{ _id: '1', content: 'a' }, { _id: '2', content: 'b' }],
        liveEndsAt: null,
      },
    });
    mockUseDanmakuSocket.mockReturnValue({
      // _id '2' already in history — should be filtered out
      live: [{ _id: '2', content: 'b' }, { _id: '3', content: 'c' }],
      connected: true,
      send: vi.fn(),
    });
    render(<DanmakuSection anilistId={1} episode={1} />);
    // Expect 3 total (2 history + 1 new)
    expect(screen.getByTestId('overlay')).toHaveTextContent('overlay:3');
  });

  it('caps the overlay to the last 30 messages', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ _id: String(i) }));
    mockUseDanmakuHistory.mockReturnValue({
      data: { data: items, liveEndsAt: null },
    });
    render(<DanmakuSection anilistId={1} episode={1} />);
    expect(screen.getByTestId('overlay')).toHaveTextContent('overlay:30');
  });

  it('only opens the socket when user is logged in and window is open', () => {
    mockUseAuth.mockReturnValue({ user: null });
    mockUseDanmakuHistory.mockReturnValue({
      data: { data: [], liveEndsAt: null },
    });
    render(<DanmakuSection anilistId={42} episode={3} />);
    // 3rd arg to useDanmakuSocket is (!!user && canSend) — false when no user
    expect(mockUseDanmakuSocket).toHaveBeenCalledWith(42, 3, false);
  });

  it('handles missing history data gracefully', () => {
    mockUseDanmakuHistory.mockReturnValue({ data: undefined });
    render(<DanmakuSection anilistId={1} episode={1} />);
    expect(screen.getByTestId('overlay')).toHaveTextContent('overlay:0');
    expect(screen.getByTestId('input')).toBeInTheDocument();
  });
});
