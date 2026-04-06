import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from '../context/AuthContext';

// Mock axios (used for silent refresh on mount)
vi.mock('axios', () => ({
  default: {
    post: vi.fn().mockRejectedValue(new Error('no session')),
  }
}));

// Mock auth API
const mockLogin = vi.fn();
const mockRegister = vi.fn();
const mockLogout = vi.fn();
const mockGetMe = vi.fn();

vi.mock('../api/auth.api', () => ({
  login: (...args) => mockLogin(...args),
  register: (...args) => mockRegister(...args),
  logout: (...args) => mockLogout(...args),
  getMe: (...args) => mockGetMe(...args),
}));

vi.mock('../api/axiosClient', () => ({
  setAccessToken: vi.fn(),
}));

function TestConsumer() {
  const { user, initializing, loading, login, register, logout } = useAuth();
  return (
    <div>
      <span data-testid="initializing">{String(initializing)}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user">{user ? user.username : 'null'}</span>
      <button onClick={() => login('a@b.com', 'pass')} data-testid="login">Login</button>
      <button onClick={() => register('alice', 'a@b.com', 'pass')} data-testid="register">Register</button>
      <button onClick={() => logout()} data-testid="logout">Logout</button>
    </div>
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with initializing=true then resolves to guest (no session)', async () => {
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('initializing').textContent).toBe('false');
    });
    expect(screen.getByTestId('user').textContent).toBe('null');
  });

  it('login sets user on success', async () => {
    mockLogin.mockResolvedValue({
      data: { data: { accessToken: 'tok', user: { username: 'alice' } } }
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('initializing').textContent).toBe('false');
    });

    await act(async () => {
      await userEvent.click(screen.getByTestId('login'));
    });

    expect(screen.getByTestId('user').textContent).toBe('alice');
  });

  it('register sets user on success', async () => {
    mockRegister.mockResolvedValue({
      data: { data: { accessToken: 'tok', user: { username: 'bob' } } }
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('initializing').textContent).toBe('false');
    });

    await act(async () => {
      await userEvent.click(screen.getByTestId('register'));
    });

    expect(screen.getByTestId('user').textContent).toBe('bob');
  });

  it('logout clears user', async () => {
    mockLogin.mockResolvedValue({
      data: { data: { accessToken: 'tok', user: { username: 'alice' } } }
    });
    mockLogout.mockResolvedValue({});

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('initializing').textContent).toBe('false');
    });

    // Login first
    await act(async () => {
      await userEvent.click(screen.getByTestId('login'));
    });
    expect(screen.getByTestId('user').textContent).toBe('alice');

    // Then logout
    await act(async () => {
      await userEvent.click(screen.getByTestId('logout'));
    });
    expect(screen.getByTestId('user').textContent).toBe('null');
  });

  it('listens for auth:expired event and clears user', async () => {
    mockLogin.mockResolvedValue({
      data: { data: { accessToken: 'tok', user: { username: 'alice' } } }
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('initializing').textContent).toBe('false');
    });

    await act(async () => {
      await userEvent.click(screen.getByTestId('login'));
    });
    expect(screen.getByTestId('user').textContent).toBe('alice');

    // Simulate token expiry event
    act(() => {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    });

    expect(screen.getByTestId('user').textContent).toBe('null');
  });
});
