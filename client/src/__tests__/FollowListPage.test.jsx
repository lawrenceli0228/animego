import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import FollowListPage from '../pages/FollowListPage';

const mockUseFollowList = vi.fn();

vi.mock('../hooks/useSocial', () => ({
  useFollowList: (...args) => mockUseFollowList(...args),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (k) => ({
      'social.followers': 'Followers',
      'social.following': 'Following',
      'social.userNotFound': 'User not found',
    }[k] || k),
  }),
}));

vi.mock('../components/common/LoadingSpinner', () => ({
  default: () => <div data-testid="spinner">loading</div>,
}));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderFlp(type = 'followers', username = 'alice') {
  return render(
    <MemoryRouter initialEntries={[`/u/${username}/${type}`]}>
      <Routes>
        <Route path="/u/:username/:type" element={<FollowListPage type={type} />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => mockUseFollowList.mockReset());

describe('FollowListPage', () => {
  it('shows Followers title when type=followers', () => {
    mockUseFollowList.mockReturnValue({ data: null, isLoading: true });
    renderFlp('followers');
    expect(screen.getByText('Followers')).toBeInTheDocument();
  });

  it('shows Following title when type=following', () => {
    mockUseFollowList.mockReturnValue({ data: null, isLoading: true });
    renderFlp('following');
    expect(screen.getByText('Following')).toBeInTheDocument();
  });

  it('shows loading spinner while loading', () => {
    mockUseFollowList.mockReturnValue({ data: null, isLoading: true });
    renderFlp();
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('shows user-not-found on error', () => {
    mockUseFollowList.mockReturnValue({ data: null, isLoading: false, isError: true });
    renderFlp();
    expect(screen.getByText('User not found')).toBeInTheDocument();
  });

  it('renders user list with clickable buttons', () => {
    mockUseFollowList.mockReturnValue({
      data: { data: [{ username: 'bob' }, { username: 'carol' }], total: 2 },
      isLoading: false, isError: false,
    });
    renderFlp();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('carol')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('navigates back to /u/:username on back-button click', () => {
    mockUseFollowList.mockReturnValue({ data: { data: [], total: 0 }, isLoading: false });
    renderFlp('followers', 'alice');
    fireEvent.click(screen.getByText(/← alice/));
    expect(screen.getByTestId('loc').textContent).toBe('/u/alice');
  });

  it('navigates to /u/:clicked when list item clicked', () => {
    mockUseFollowList.mockReturnValue({
      data: { data: [{ username: 'bob' }], total: 1 },
      isLoading: false,
    });
    renderFlp();
    fireEvent.click(screen.getByText('bob'));
    expect(screen.getByTestId('loc').textContent).toBe('/u/bob');
  });

  it('shows dash when list empty', () => {
    mockUseFollowList.mockReturnValue({ data: { data: [], total: 0 }, isLoading: false });
    renderFlp();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
