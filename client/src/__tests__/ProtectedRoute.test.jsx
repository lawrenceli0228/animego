import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProtectedRoute from '../components/common/ProtectedRoute';

// Mock AuthContext — we control what useAuth returns per test
const mockUseAuth = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

// Mock LoadingSpinner so we can assert on its rendering without styling concerns
vi.mock('../components/common/LoadingSpinner', () => ({
  default: () => <div data-testid="loading-spinner" />,
}));

function renderWithRouter(initialPath = '/protected') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
        <Route
          path="/protected"
          element={
            <ProtectedRoute>
              <div data-testid="protected-content">Secret</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    mockUseAuth.mockReset();
  });

  it('shows LoadingSpinner while initializing', () => {
    mockUseAuth.mockReturnValue({ user: null, initializing: true });
    renderWithRouter();

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });

  it('redirects to /login when no user and not initializing', () => {
    mockUseAuth.mockReturnValue({ user: null, initializing: false });
    renderWithRouter();

    expect(screen.getByTestId('login-page')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('renders children when user is authenticated', () => {
    mockUseAuth.mockReturnValue({ user: { username: 'alice' }, initializing: false });
    renderWithRouter();

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument();
  });

  it('does not redirect prematurely while session check is pending', () => {
    // Regression guard: if initializing=true but user=null, we must NOT redirect
    mockUseAuth.mockReturnValue({ user: null, initializing: true });
    renderWithRouter();

    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });
});
