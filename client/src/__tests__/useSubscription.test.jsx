import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSubscriptions, useSubscription, useAddSubscription, useUpdateSubscription, useRemoveSubscription } from '../hooks/useSubscription';

const mockGetSubscriptions = vi.fn();
const mockGetSubscription = vi.fn();
const mockAddSubscription = vi.fn();
const mockUpdateSubscription = vi.fn();
const mockRemoveSubscription = vi.fn();

vi.mock('../api/subscription.api', () => ({
  getSubscriptions: (...args) => mockGetSubscriptions(...args),
  getSubscription: (...args) => mockGetSubscription(...args),
  addSubscription: (...args) => mockAddSubscription(...args),
  updateSubscription: (...args) => mockUpdateSubscription(...args),
  removeSubscription: (...args) => mockRemoveSubscription(...args),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { userId: 'user123', username: 'alice' } }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useSubscriptions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches user subscriptions', async () => {
    const subs = [{ anilistId: 101, status: 'watching' }];
    mockGetSubscriptions.mockResolvedValue({ data: { data: subs } });

    const { result } = renderHook(() => useSubscriptions(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(subs);
  });

  it('passes status filter', async () => {
    mockGetSubscriptions.mockResolvedValue({ data: { data: [] } });

    renderHook(() => useSubscriptions('completed'), { wrapper: createWrapper() });

    await waitFor(() => expect(mockGetSubscriptions).toHaveBeenCalledWith('completed'));
  });
});

describe('useSubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches single subscription', async () => {
    const sub = { anilistId: 101, status: 'watching', currentEpisode: 5 };
    mockGetSubscription.mockResolvedValue({ data: { data: sub } });

    const { result } = renderHook(() => useSubscription(101), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sub);
  });

  it('returns null for 404', async () => {
    mockGetSubscription.mockRejectedValue({ response: { status: 404 } });

    const { result } = renderHook(() => useSubscription(999), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});

describe('useAddSubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls addSubscription API', async () => {
    mockAddSubscription.mockResolvedValue({ data: { data: { anilistId: 101 } } });

    const { result } = renderHook(() => useAddSubscription(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ anilistId: 101, status: 'watching' });
    expect(mockAddSubscription).toHaveBeenCalledWith({ anilistId: 101, status: 'watching' });
  });
});

describe('useUpdateSubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls updateSubscription API with anilistId and data', async () => {
    mockUpdateSubscription.mockResolvedValue({ data: { data: { status: 'completed' } } });

    const { result } = renderHook(() => useUpdateSubscription(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ anilistId: 101, status: 'completed' });
    expect(mockUpdateSubscription).toHaveBeenCalledWith(101, { status: 'completed' });
  });
});

describe('useRemoveSubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls removeSubscription API', async () => {
    mockRemoveSubscription.mockResolvedValue({ data: { data: { message: 'deleted' } } });

    const { result } = renderHook(() => useRemoveSubscription(), { wrapper: createWrapper() });

    await result.current.mutateAsync(101);
    expect(mockRemoveSubscription).toHaveBeenCalledWith(101);
  });
});
