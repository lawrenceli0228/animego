import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DanmakuInput from '../components/anime/DanmakuInput';

const mockUseAuth = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'sub.loginToWatch': 'Log in',
      'danmaku.loginSuffix': 'to join',
      'danmaku.connected': 'Connected',
      'danmaku.connecting': 'Connecting...',
      'danmaku.placeholder': 'Say something',
      'danmaku.send': 'Send',
    }[key] || key),
  }),
}));

function renderInput(props) {
  return render(
    <MemoryRouter initialEntries={['/current']}>
      <Routes>
        <Route path="/current" element={<DanmakuInput {...props} />} />
        <Route path="/login" element={<div data-testid="login-page" />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockUseAuth.mockReset();
});

describe('DanmakuInput — logged out', () => {
  it('shows a login prompt instead of the input', () => {
    mockUseAuth.mockReturnValue({ user: null });
    renderInput({ onSend: vi.fn(), connected: true });

    expect(screen.getByText('Log in')).toBeInTheDocument();
    expect(screen.getByText('to join')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('navigates to /login when the login button is clicked', () => {
    mockUseAuth.mockReturnValue({ user: null });
    renderInput({ onSend: vi.fn(), connected: true });

    fireEvent.click(screen.getByText('Log in'));
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });
});

describe('DanmakuInput — logged in', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: { username: 'alice' } });
  });

  it('renders input, counter, and send button when connected', () => {
    renderInput({ onSend: vi.fn(), connected: true });
    expect(screen.getByPlaceholderText('Say something')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(screen.getByText('0/50')).toBeInTheDocument();
  });

  it('disables input and send button when disconnected', () => {
    renderInput({ onSend: vi.fn(), connected: false });
    expect(screen.getByPlaceholderText('Connecting...')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('updates the character counter as the user types', async () => {
    renderInput({ onSend: vi.fn(), connected: true });
    await userEvent.type(screen.getByPlaceholderText('Say something'), 'hi');
    expect(screen.getByText('2/50')).toBeInTheDocument();
  });

  it('truncates input past the 50-char limit', async () => {
    renderInput({ onSend: vi.fn(), connected: true });
    const input = screen.getByPlaceholderText('Say something');
    // Typing 55 chars directly; jsdom respects maxLength but test slice() logic too
    fireEvent.change(input, { target: { value: 'a'.repeat(100) } });
    expect(screen.getByText('50/50')).toBeInTheDocument();
    expect(input.value.length).toBe(50);
  });

  it('calls onSend with trimmed value when Send is clicked and clears input', async () => {
    const onSend = vi.fn();
    renderInput({ onSend, connected: true });

    const input = screen.getByPlaceholderText('Say something');
    await userEvent.type(input, '  hello  ');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
  });

  it('submits on Enter key', async () => {
    const onSend = vi.fn();
    renderInput({ onSend, connected: true });

    const input = screen.getByPlaceholderText('Say something');
    await userEvent.type(input, 'hi{Enter}');

    expect(onSend).toHaveBeenCalledWith('hi');
  });

  it('does not send when the value is empty or whitespace-only', () => {
    const onSend = vi.fn();
    renderInput({ onSend, connected: true });

    const input = screen.getByPlaceholderText('Say something');
    fireEvent.change(input, { target: { value: '   ' } });
    // Button is disabled due to !value.trim(), but click still shouldn't call
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send when disconnected, even with valid text', async () => {
    const onSend = vi.fn();
    const { rerender } = renderInput({ onSend, connected: true });

    const input = screen.getByPlaceholderText('Say something');
    await userEvent.type(input, 'hi');

    rerender(
      <MemoryRouter>
        <DanmakuInput onSend={onSend} connected={false} />
      </MemoryRouter>
    );

    // Re-find input — disconnected placeholder differs
    fireEvent.keyDown(
      screen.getByPlaceholderText('Connecting...'),
      { key: 'Enter' }
    );
    expect(onSend).not.toHaveBeenCalled();
  });
});
