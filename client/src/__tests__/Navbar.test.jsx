import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Navbar from '../components/layout/Navbar';

const mockUseAuth = vi.fn();
const mockToggle = vi.fn();
const mockLogout = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'nav.home': 'Home',
      'nav.season': 'Season',
      'nav.search': 'Search',
      'nav.player': 'Player',
      'nav.hi': 'Hi',
      'nav.login': 'Log in',
      'nav.register': 'Register',
      'nav.logout': 'Logout',
      'nav.myList': 'My list',
      'admin.navLabel': 'Admin',
    }[key] || key),
    lang: 'en',
    toggle: mockToggle,
  }),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: (...args) => mockToastSuccess(...args) },
}));

function renderNavbar(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<Navbar />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockUseAuth.mockReset();
  mockToggle.mockReset();
  mockLogout.mockReset();
  mockToastSuccess.mockReset();
  mockLogout.mockResolvedValue(undefined);
});

describe('Navbar — logged out', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: null, logout: mockLogout });
  });

  it('renders logo, nav links, and login/register', () => {
    renderNavbar();
    expect(screen.getByText('AnimeGo')).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Season')).toBeInTheDocument();
    expect(screen.getByText('Log in')).toBeInTheDocument();
    expect(screen.getByText('Register')).toBeInTheDocument();
    expect(screen.queryByText('Logout')).not.toBeInTheDocument();
  });

  it('language toggle button calls toggle', () => {
    renderNavbar();
    // In en, toggle button shows "中"
    fireEvent.click(screen.getByText('中'));
    expect(mockToggle).toHaveBeenCalled();
  });
});

describe('Navbar — logged in', () => {
  it('shows username, My list, Logout (no Admin for non-admin users)', () => {
    mockUseAuth.mockReturnValue({
      user: { username: 'alice', role: 'user' },
      logout: mockLogout,
    });
    renderNavbar();
    expect(screen.getByText(/alice/)).toBeInTheDocument();
    expect(screen.getByText('My list')).toBeInTheDocument();
    expect(screen.getByText('Logout')).toBeInTheDocument();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('shows Admin link for admin role', () => {
    mockUseAuth.mockReturnValue({
      user: { username: 'root', role: 'admin' },
      logout: mockLogout,
    });
    renderNavbar();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('logs out and toasts success', async () => {
    mockUseAuth.mockReturnValue({
      user: { username: 'alice', role: 'user' },
      logout: mockLogout,
    });
    renderNavbar();
    fireEvent.click(screen.getByText('Logout'));
    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith('Logout');
    });
  });
});
