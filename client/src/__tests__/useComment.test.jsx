import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useComments, useAddComment, useDeleteComment } from '../hooks/useComment';

const mockGetComments = vi.fn();
const mockAddComment = vi.fn();
const mockDeleteComment = vi.fn();

vi.mock('../api/comment.api', () => ({
  getComments: (...args) => mockGetComments(...args),
  addComment: (...args) => mockAddComment(...args),
  deleteComment: (...args) => mockDeleteComment(...args),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useComments', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches comments for an episode', async () => {
    const comments = [{ _id: 'c1', content: 'Great episode!' }];
    mockGetComments.mockResolvedValue({ data: { data: comments } });

    const { result } = renderHook(() => useComments(101, 1), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(comments);
    expect(mockGetComments).toHaveBeenCalledWith(101, 1);
  });

  it('is disabled when anilistId or episode is missing', () => {
    const { result } = renderHook(() => useComments(null, null), { wrapper: createWrapper() });
    expect(result.current.isFetching).toBe(false);
  });
});

describe('useAddComment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls addComment API', async () => {
    mockAddComment.mockResolvedValue({ data: { data: { _id: 'c2', content: 'Nice!' } } });

    const { result } = renderHook(() => useAddComment(101, 1), { wrapper: createWrapper() });

    await result.current.mutateAsync('Nice!');
    expect(mockAddComment).toHaveBeenCalledWith(101, 1, { content: 'Nice!' });
  });
});

describe('useDeleteComment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls deleteComment API', async () => {
    mockDeleteComment.mockResolvedValue({ data: { data: { message: 'deleted' } } });

    const { result } = renderHook(() => useDeleteComment(101, 1), { wrapper: createWrapper() });

    await result.current.mutateAsync('c1');
    expect(mockDeleteComment).toHaveBeenCalledWith('c1');
  });
});
