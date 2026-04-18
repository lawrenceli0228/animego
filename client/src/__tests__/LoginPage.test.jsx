import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LoginPage from '../pages/LoginPage';

const mockLogin = vi.fn();
const mockUseAuth = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'login.title': 'Sign in',
      'login.subtitle': 'Welcome back',
      'login.email': 'Email',
      'login.password': 'Password',
      'login.submit': 'Log in',
      'login.submitting': 'Logging in...',
      'login.success': 'Welcome back!',
      'login.fail': 'Login failed',
      'login.noAccount': 'No account?',
      'login.registerLink': 'Register',
      'login.forgotPassword': 'Forgot password?',
    }[key] || key),
  }),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: (...args) => mockToastSuccess(...args), error: vi.fn() },
}));

function renderLogin(initialPath = '/login') {
  const utils = render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div data-testid="home">Home</div>} />
        <Route path="/register" element={<div data-testid="register-page" />} />
      </Routes>
    </MemoryRouter>
  );
  const emailInput = () => utils.container.querySelector('input[type="email"]');
  const passwordInput = () => utils.container.querySelector('input[type="password"]');
  return { ...utils, emailInput, passwordInput };
}

beforeEach(() => {
  mockLogin.mockReset();
  mockUseAuth.mockReset();
  mockToastSuccess.mockReset();
  mockUseAuth.mockReturnValue({ login: mockLogin, user: null, initializing: false });
});

describe('LoginPage', () => {
  it('renders the form with email and password fields', () => {
    const { emailInput, passwordInput } = renderLogin();
    expect(screen.getByText('Sign in')).toBeInTheDocument();
    expect(emailInput()).toBeInTheDocument();
    expect(passwordInput()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
  });

  it('redirects to "/" when already authenticated', () => {
    mockUseAuth.mockReturnValue({ login: mockLogin, user: { id: 1 }, initializing: false });
    renderLogin();
    expect(screen.getByTestId('home')).toBeInTheDocument();
    expect(screen.queryByText('Sign in')).not.toBeInTheDocument();
  });

  it('does not redirect while auth is still initializing', () => {
    mockUseAuth.mockReturnValue({ login: mockLogin, user: { id: 1 }, initializing: true });
    renderLogin();
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });

  it('submits email/password and navigates home on success', async () => {
    mockLogin.mockResolvedValue({ id: 1 });
    const { emailInput, passwordInput } = renderLogin();

    await userEvent.type(emailInput(), 'a@b.co');
    await userEvent.type(passwordInput(), 'secret');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('a@b.co', 'secret');
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Welcome back!');
    await waitFor(() => expect(screen.getByTestId('home')).toBeInTheDocument());
  });

  it('shows the server error message when login fails with response payload', async () => {
    mockLogin.mockRejectedValue({
      response: { data: { error: { message: 'Invalid credentials' } } },
    });
    const { emailInput, passwordInput } = renderLogin();

    await userEvent.type(emailInput(), 'a@b.co');
    await userEvent.type(passwordInput(), 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('falls back to a generic error message when server returns no payload', async () => {
    mockLogin.mockRejectedValue(new Error('network'));
    const { emailInput, passwordInput } = renderLogin();

    await userEvent.type(emailInput(), 'a@b.co');
    await userEvent.type(passwordInput(), 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('Login failed')).toBeInTheDocument();
  });

  it('disables the submit button while the login request is in flight', async () => {
    let resolve;
    mockLogin.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { emailInput, passwordInput } = renderLogin();

    await userEvent.type(emailInput(), 'a@b.co');
    await userEvent.type(passwordInput(), 'secret');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('button', { name: 'Logging in...' })).toBeDisabled();
    resolve({ id: 1 });
  });
});
