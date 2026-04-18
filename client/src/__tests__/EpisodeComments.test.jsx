import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import EpisodeComments from '../components/anime/EpisodeComments';

const mockUseAuth = vi.fn();
const mockUseComments = vi.fn();
const mockAddMutate = vi.fn();
const mockDeleteMutate = vi.fn();
const mockUseAddComment = vi.fn();
const mockUseDeleteComment = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'comment.title': 'COMMENTS',
      'comment.placeholder': 'Say something',
      'comment.post': 'Post',
      'comment.posting': 'Posting...',
      'comment.cancel': 'Cancel',
      'comment.delete': 'Delete',
      'comment.deleteConfirm': 'Confirm?',
      'comment.loginPrompt': 'Please ',
      'comment.loginLink': 'log in',
      'comment.loginSuffix': ' to comment',
      'comment.noComments': 'No comments yet',
    }[key] || key),
    lang: 'en',
  }),
}));

vi.mock('../hooks/useComment', () => ({
  useComments: (...args) => mockUseComments(...args),
  useAddComment: (...args) => mockUseAddComment(...args),
  useDeleteComment: (...args) => mockUseDeleteComment(...args),
}));

function renderComments(props = { anilistId: 1, episode: 1 }) {
  return render(
    <MemoryRouter>
      <EpisodeComments {...props} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockUseAuth.mockReset();
  mockUseComments.mockReset();
  mockAddMutate.mockReset();
  mockDeleteMutate.mockReset();
  mockUseAddComment.mockReset();
  mockUseDeleteComment.mockReset();

  mockUseAuth.mockReturnValue({ user: { _id: 'u1', username: 'alice' } });
  mockUseComments.mockReturnValue({ data: [], isLoading: false });
  mockUseAddComment.mockReturnValue({ mutate: mockAddMutate, isPending: false });
  mockUseDeleteComment.mockReturnValue({ mutate: mockDeleteMutate });
});

describe('EpisodeComments', () => {
  it('renders the comments title with episode number', () => {
    renderComments({ anilistId: 1, episode: 5 });
    expect(screen.getByText(/COMMENTS · Ep 5/)).toBeInTheDocument();
  });

  it('renders the no-comments empty state', () => {
    renderComments();
    expect(screen.getByText('No comments yet')).toBeInTheDocument();
  });

  it('shows the login prompt when user is not logged in', () => {
    mockUseAuth.mockReturnValue({ user: null });
    renderComments();
    expect(screen.getByText(/Please/)).toBeInTheDocument();
    expect(screen.getByText('log in')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Say something')).not.toBeInTheDocument();
  });

  it('posts a comment via addComment when Post is clicked', async () => {
    renderComments();
    const textarea = screen.getByPlaceholderText('Say something');
    await userEvent.type(textarea, 'hello world');
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));

    expect(mockAddMutate).toHaveBeenCalledWith('hello world', expect.objectContaining({
      onSuccess: expect.any(Function),
    }));
  });

  it('disables the Post button when input is empty', () => {
    renderComments();
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
  });

  it('shows character counter', async () => {
    renderComments();
    await userEvent.type(screen.getByPlaceholderText('Say something'), 'hi');
    expect(screen.getByText('2/500')).toBeInTheDocument();
  });

  it('renders top-level comments in reverse order (newest first)', () => {
    mockUseComments.mockReturnValue({
      data: [
        { _id: '1', userId: 'u2', username: 'bob', content: 'first', createdAt: '2025-01-01T00:00:00Z' },
        { _id: '2', userId: 'u3', username: 'carol', content: 'second', createdAt: '2025-01-02T00:00:00Z' },
      ],
      isLoading: false,
    });
    const { container } = renderComments();
    const paragraphs = [...container.querySelectorAll('p')].map(p => p.textContent);
    // newest ('second') should appear before 'first'
    const firstIdx = paragraphs.findIndex(t => t?.includes('first'));
    const secondIdx = paragraphs.findIndex(t => t?.includes('second'));
    expect(secondIdx).toBeLessThan(firstIdx);
  });

  it('shows Delete button for own comments only', () => {
    mockUseComments.mockReturnValue({
      data: [
        { _id: '1', userId: 'u1', username: 'alice', content: 'mine', createdAt: '2025-01-01T00:00:00Z' },
        { _id: '2', userId: 'u2', username: 'bob', content: 'theirs', createdAt: '2025-01-01T00:00:00Z' },
      ],
      isLoading: false,
    });
    renderComments();
    // Only one Delete button (for alice's comment)
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });

  it('two-step delete: click Delete → Confirm triggers deleteComment', () => {
    mockUseComments.mockReturnValue({
      data: [{ _id: '1', userId: 'u1', username: 'alice', content: 'mine', createdAt: '2025-01-01T00:00:00Z' }],
      isLoading: false,
    });
    renderComments();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // Confirm button now visible
    fireEvent.click(screen.getByRole('button', { name: 'Confirm?' }));
    expect(mockDeleteMutate).toHaveBeenCalledWith('1');
  });

  it('cancel aborts deletion', () => {
    mockUseComments.mockReturnValue({
      data: [{ _id: '1', userId: 'u1', username: 'alice', content: 'mine', createdAt: '2025-01-01T00:00:00Z' }],
      isLoading: false,
    });
    renderComments();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockDeleteMutate).not.toHaveBeenCalled();
  });

  it('clicking Reply opens the reply input with target username', async () => {
    mockUseComments.mockReturnValue({
      data: [{ _id: '1', userId: 'u2', username: 'bob', content: 'hi', createdAt: '2025-01-01T00:00:00Z' }],
      isLoading: false,
    });
    renderComments();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(screen.getByText(/Replying to @bob/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Reply to bob...')).toBeInTheDocument();
  });

  it('submitting a reply calls addComment with parentId and replyToUsername', async () => {
    mockUseComments.mockReturnValue({
      data: [{ _id: 'p1', userId: 'u2', username: 'bob', content: 'hi', createdAt: '2025-01-01T00:00:00Z' }],
      isLoading: false,
    });
    renderComments();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const replyInput = screen.getByPlaceholderText('Reply to bob...');
    await userEvent.type(replyInput, 'thanks!');
    // The reply Post button is the second one (main input's Post is still there)
    const postButtons = screen.getAllByRole('button', { name: 'Post' });
    fireEvent.click(postButtons[postButtons.length - 1]);

    expect(mockAddMutate).toHaveBeenCalledWith(
      { content: 'thanks!', parentId: 'p1', replyToUsername: 'bob' },
      expect.any(Object)
    );
  });

  it('Ctrl+Enter shortcut posts the comment', async () => {
    renderComments();
    const textarea = screen.getByPlaceholderText('Say something');
    await userEvent.type(textarea, 'quick');
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(mockAddMutate).toHaveBeenCalledWith('quick', expect.any(Object));
  });

  it('renders nested replies as children of their parent', () => {
    mockUseComments.mockReturnValue({
      data: [
        { _id: 'p1', userId: 'u2', username: 'bob', content: 'parent', createdAt: '2025-01-01T00:00:00Z' },
        { _id: 'r1', userId: 'u3', username: 'carol', content: 'reply!', parentId: 'p1', replyToUsername: 'bob', createdAt: '2025-01-01T01:00:00Z' },
      ],
      isLoading: false,
    });
    renderComments();
    expect(screen.getByText('parent')).toBeInTheDocument();
    expect(screen.getByText('reply!')).toBeInTheDocument();
    // Reply arrow → bob
    expect(screen.getByText('→ bob')).toBeInTheDocument();
  });
});
