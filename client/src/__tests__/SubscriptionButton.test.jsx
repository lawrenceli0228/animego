import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SubscriptionButton from '../components/subscription/SubscriptionButton';

const mockUseAuth = vi.fn();
const mockUseSubscription = vi.fn();
const mockAdd = vi.fn();
const mockUpdate = vi.fn();
const mockRemove = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'sub.loginToWatch': 'Log in to track',
      'sub.addToList': 'Add to list',
      'sub.watching': 'Watching',
      'sub.completed': 'Completed',
      'sub.planToWatch': 'Plan',
      'sub.dropped': 'Dropped',
      'sub.rate': 'Rate',
      'sub.remove': 'Remove',
      'sub.epUnit': 'ep',
    }[key] || key),
  }),
}));

vi.mock('../hooks/useSubscription', () => ({
  useSubscription: (...args) => mockUseSubscription(...args),
  useAddSubscription: () => ({ mutateAsync: mockAdd }),
  useUpdateSubscription: () => ({ mutateAsync: mockUpdate }),
  useRemoveSubscription: () => ({ mutateAsync: mockRemove }),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: (...args) => mockToastSuccess(...args),
    error: (...args) => mockToastError(...args),
  },
}));

function renderButton(props = { anilistId: 42, episodes: 12 }) {
  return render(
    <MemoryRouter>
      <SubscriptionButton {...props} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockUseAuth.mockReset();
  mockUseSubscription.mockReset();
  mockAdd.mockReset().mockResolvedValue({});
  mockUpdate.mockReset().mockResolvedValue({});
  mockRemove.mockReset().mockResolvedValue({});
  mockToastSuccess.mockReset();
  mockToastError.mockReset();

  mockUseAuth.mockReturnValue({ user: { _id: 'u1' } });
  mockUseSubscription.mockReturnValue({ data: null, isLoading: false });
});

describe('SubscriptionButton', () => {
  it('shows a login link when user is not signed in', () => {
    mockUseAuth.mockReturnValue({ user: null });
    renderButton();
    expect(screen.getByText('Log in to track')).toBeInTheDocument();
  });

  it('renders nothing while subscription is loading', () => {
    mockUseSubscription.mockReturnValue({ data: null, isLoading: true });
    const { container } = renderButton();
    expect(container.firstChild).toBeNull();
  });

  it('shows the status dropdown with no subscription yet', () => {
    renderButton();
    expect(screen.getByText('Add to list')).toBeInTheDocument();
    expect(screen.queryByText('Remove')).not.toBeInTheDocument();
  });

  it('calls add mutation when selecting a status for the first time', async () => {
    renderButton();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'watching' } });
    await waitFor(() => {
      expect(mockAdd).toHaveBeenCalledWith({ anilistId: 42, status: 'watching' });
    });
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('calls update mutation when changing status for existing subscription', async () => {
    mockUseSubscription.mockReturnValue({
      data: { status: 'watching', currentEpisode: 3 },
      isLoading: false,
    });
    renderButton();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dropped' } });
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith({ anilistId: 42, status: 'dropped' });
    });
  });

  it('renders episode counter when subscribed', () => {
    mockUseSubscription.mockReturnValue({
      data: { status: 'watching', currentEpisode: 5 },
      isLoading: false,
    });
    renderButton();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText(/\/ 12/)).toBeInTheDocument();
  });

  it('+ button increments currentEpisode via update', async () => {
    mockUseSubscription.mockReturnValue({
      data: { status: 'watching', currentEpisode: 3 },
      isLoading: false,
    });
    renderButton();
    fireEvent.click(screen.getByText('+'));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ anilistId: 42, currentEpisode: 4 })
      );
    });
  });

  it('auto-completes status when incrementing past the last episode', async () => {
    mockUseSubscription.mockReturnValue({
      data: { status: 'watching', currentEpisode: 11 },
      isLoading: false,
    });
    renderButton({ anilistId: 42, episodes: 12 });
    fireEvent.click(screen.getByText('+'));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
        currentEpisode: 12, status: 'completed',
      }));
    });
  });

  it('auto-resumes to watching when decrementing while completed', async () => {
    mockUseSubscription.mockReturnValue({
      data: { status: 'completed', currentEpisode: 12 },
      isLoading: false,
    });
    renderButton({ anilistId: 42, episodes: 12 });
    fireEvent.click(screen.getByText('−'));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
        currentEpisode: 11, status: 'watching',
      }));
    });
  });

  it('clamps episode to minimum 0', async () => {
    mockUseSubscription.mockReturnValue({
      data: { status: 'watching', currentEpisode: 0 },
      isLoading: false,
    });
    renderButton({ anilistId: 42, episodes: 12 });
    fireEvent.click(screen.getByText('−'));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ currentEpisode: 0 }));
    });
  });

  it('opens and sets score via the score picker', async () => {
    mockUseSubscription.mockReturnValue({
      data: { status: 'watching', currentEpisode: 3, score: null },
      isLoading: false,
    });
    renderButton();
    fireEvent.click(screen.getByText(/★ Rate/));
    fireEvent.click(screen.getByText('8'));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith({ anilistId: 42, score: 8 });
    });
  });

  it('clears score when clicking the current score', async () => {
    mockUseSubscription.mockReturnValue({
      data: { status: 'watching', currentEpisode: 3, score: 7 },
      isLoading: false,
    });
    renderButton();
    fireEvent.click(screen.getByText(/7\/10/));
    fireEvent.click(screen.getByText('7'));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith({ anilistId: 42, score: null });
    });
  });

  it('removes subscription when Remove clicked', async () => {
    mockUseSubscription.mockReturnValue({
      data: { status: 'watching', currentEpisode: 3 },
      isLoading: false,
    });
    renderButton();
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => {
      expect(mockRemove).toHaveBeenCalledWith(42);
    });
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('toasts error when remove mutation fails', async () => {
    mockRemove.mockRejectedValue(new Error('boom'));
    mockUseSubscription.mockReturnValue({
      data: { status: 'watching', currentEpisode: 3 },
      isLoading: false,
    });
    renderButton();
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
  });
});
