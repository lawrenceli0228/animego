import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RegisterPage from '../pages/RegisterPage';

const mockRegister = vi.fn();
const mockUseAuth = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'register.title': 'Create account',
      'register.subtitle': 'Join us',
      'register.username': 'Username',
      'register.email': 'Email',
      'register.password': 'Password',
      'register.submit': 'Register',
      'register.submitting': 'Registering...',
      'register.success': 'Welcome!',
      'register.fail': 'Registration failed',
      'register.pwdTooShort': 'Password must be 6+ chars',
      'register.hasAccount': 'Have an account?',
      'register.loginLink': 'Log in',
    }[key] || key),
  }),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: (...args) => mockToastSuccess(...args), error: vi.fn() },
}));

function renderRegister() {
  const utils = render(
    <MemoryRouter initialEntries={['/register']}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/" element={<div data-testid="home">Home</div>} />
        <Route path="/login" element={<div data-testid="login-page" />} />
      </Routes>
    </MemoryRouter>
  );
  return {
    ...utils,
    usernameInput: () => utils.container.querySelector('input[type="text"]'),
    emailInput: () => utils.container.querySelector('input[type="email"]'),
    passwordInput: () => utils.container.querySelector('input[type="password"]'),
  };
}

beforeEach(() => {
  mockRegister.mockReset();
  mockUseAuth.mockReset();
  mockToastSuccess.mockReset();
  mockUseAuth.mockReturnValue({ register: mockRegister, user: null, initializing: false });
});

describe('RegisterPage', () => {
  it('renders the form with username, email, and password fields', () => {
    const { usernameInput, emailInput, passwordInput } = renderRegister();
    expect(screen.getByText('Create account')).toBeInTheDocument();
    expect(usernameInput()).toBeInTheDocument();
    expect(emailInput()).toBeInTheDocument();
    expect(passwordInput()).toBeInTheDocument();
  });

  it('redirects authenticated users to home', () => {
    mockUseAuth.mockReturnValue({ register: mockRegister, user: { id: 1 }, initializing: false });
    renderRegister();
    expect(screen.getByTestId('home')).toBeInTheDocument();
    expect(screen.queryByText('Create account')).not.toBeInTheDocument();
  });

  it('rejects passwords shorter than 6 characters without calling register', async () => {
    const { usernameInput, emailInput, passwordInput } = renderRegister();

    await userEvent.type(usernameInput(), 'alice');
    await userEvent.type(emailInput(), 'a@b.co');
    await userEvent.type(passwordInput(), '12345');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    expect(await screen.findByText('Password must be 6+ chars')).toBeInTheDocument();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('submits when password is long enough and navigates home on success', async () => {
    mockRegister.mockResolvedValue({ id: 1 });
    const { usernameInput, emailInput, passwordInput } = renderRegister();

    await userEvent.type(usernameInput(), 'alice');
    await userEvent.type(emailInput(), 'a@b.co');
    await userEvent.type(passwordInput(), 'secret');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledWith('alice', 'a@b.co', 'secret');
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Welcome!');
    await waitFor(() => expect(screen.getByTestId('home')).toBeInTheDocument());
  });

  it('shows the server error message when register fails with response payload', async () => {
    mockRegister.mockRejectedValue({
      response: { data: { error: { message: 'Email already taken' } } },
    });
    const { usernameInput, emailInput, passwordInput } = renderRegister();

    await userEvent.type(usernameInput(), 'alice');
    await userEvent.type(emailInput(), 'a@b.co');
    await userEvent.type(passwordInput(), 'secret');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    expect(await screen.findByText('Email already taken')).toBeInTheDocument();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('falls back to a generic error when no server payload', async () => {
    mockRegister.mockRejectedValue(new Error('network'));
    const { usernameInput, emailInput, passwordInput } = renderRegister();

    await userEvent.type(usernameInput(), 'alice');
    await userEvent.type(emailInput(), 'a@b.co');
    await userEvent.type(passwordInput(), 'secret');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    expect(await screen.findByText('Registration failed')).toBeInTheDocument();
  });

  it('disables the submit button while the register request is in flight', async () => {
    let resolve;
    mockRegister.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { usernameInput, emailInput, passwordInput } = renderRegister();

    await userEvent.type(usernameInput(), 'alice');
    await userEvent.type(emailInput(), 'a@b.co');
    await userEvent.type(passwordInput(), 'secret');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    expect(await screen.findByRole('button', { name: 'Registering...' })).toBeDisabled();
    resolve({ id: 1 });
  });
});
