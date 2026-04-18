import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WeeklySchedule from '../components/anime/WeeklySchedule';

const mockUseSchedule = vi.fn();

vi.mock('../hooks/useAnime', () => ({
  useWeeklySchedule: () => mockUseSchedule(),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (k) => ({
      'home.scheduleLabel': 'SCHEDULE',
      'home.thisWeek': 'This Week',
      'home.today': 'Today',
      'home.noUpdates': 'No updates',
      'detail.ep': 'Ep',
      'detail.epUnit': 'ep',
    }[k] || k),
    lang: 'en',
  }),
}));

vi.mock('../utils/formatters', () => ({
  pickTitle: (a) => a.titleRomaji || 'Untitled',
}));

function renderWs() {
  return render(<MemoryRouter><WeeklySchedule /></MemoryRouter>);
}

beforeEach(() => mockUseSchedule.mockReset());

describe('WeeklySchedule', () => {
  it('renders nothing while loading', () => {
    mockUseSchedule.mockReturnValue({ data: null, isLoading: true });
    const { container } = renderWs();
    expect(container.firstChild).toBeNull();
  });

  it('shows section headers when data present', () => {
    mockUseSchedule.mockReturnValue({
      data: { groups: { '2026-04-14': [] } },
      isLoading: false,
    });
    renderWs();
    expect(screen.getByText('SCHEDULE')).toBeInTheDocument();
    expect(screen.getByText('This Week')).toBeInTheDocument();
  });

  it('shows no-updates message when day has no items', () => {
    mockUseSchedule.mockReturnValue({
      data: { groups: { '2026-04-14': [] } },
      isLoading: false,
    });
    renderWs();
    expect(screen.getByText('No updates')).toBeInTheDocument();
  });

  it('renders cards with title, episode and link', () => {
    mockUseSchedule.mockReturnValue({
      data: {
        groups: {
          '2026-04-14': [
            { scheduleId: 's1', anilistId: 1, titleRomaji: 'A', coverImageUrl: 'a.jpg', episode: 3, airingAt: 1700000000, averageScore: 85 },
          ],
        },
      },
      isLoading: false,
    });
    renderWs();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText(/Ep 3 ep/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/anime/1');
  });

  it('shows star score when averageScore > 0', () => {
    mockUseSchedule.mockReturnValue({
      data: {
        groups: {
          '2026-04-14': [
            { scheduleId: 's1', anilistId: 1, titleRomaji: 'A', coverImageUrl: 'a.jpg', episode: 3, airingAt: 1700000000, averageScore: 85 },
          ],
        },
      },
      isLoading: false,
    });
    renderWs();
    expect(screen.getByText(/★ 8\.5/)).toBeInTheDocument();
  });

  it('hides score when averageScore is 0', () => {
    mockUseSchedule.mockReturnValue({
      data: {
        groups: {
          '2026-04-14': [
            { scheduleId: 's1', anilistId: 1, titleRomaji: 'A', coverImageUrl: 'a', episode: 1, airingAt: 1700000000, averageScore: 0 },
          ],
        },
      },
      isLoading: false,
    });
    renderWs();
    expect(screen.queryByText(/★/)).not.toBeInTheDocument();
  });

  it('switches day when tab clicked', () => {
    mockUseSchedule.mockReturnValue({
      data: {
        groups: {
          '2026-04-14': [],
          '2026-04-15': [
            { scheduleId: 's1', anilistId: 1, titleRomaji: 'Second', coverImageUrl: 'x', episode: 1, airingAt: 1700000000, averageScore: 0 },
          ],
        },
      },
      isLoading: false,
    });
    renderWs();
    const tabs = screen.getAllByRole('button');
    fireEvent.click(tabs[1]);
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('shows per-day count next to the tab label', () => {
    mockUseSchedule.mockReturnValue({
      data: {
        groups: {
          '2026-04-14': [{}, {}, {}],
        },
      },
      isLoading: false,
    });
    renderWs();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
