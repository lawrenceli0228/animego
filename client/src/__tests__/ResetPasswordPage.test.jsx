import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ResetPasswordPage from '../pages/ResetPasswordPage';

const postMock = vi.fn();
const toastSuccess = vi.fn();

vi.mock('../api/axiosClient', () => ({
  default: { post: (...a) => postMock(...a) },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: (m) => toastSuccess(m), error: vi.fn() },
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ t: (k) => k }),
}));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderRp() {
  return render(
    <MemoryRouter initialEntries={['/reset/abc123']}>
      <Routes>
        <Route path="/reset/:token" element={<ResetPasswordPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  postMock.mockReset();
  toastSuccess.mockReset();
});

describe('ResetPasswordPage', () => {
  it('renders title and two password fields', () => {
    renderRp();
    expect(screen.getByText('resetPassword.title')).toBeInTheDocument();
    const inputs = document.querySelectorAll('input[type="password"]');
    expect(inputs.length).toBe(2);
  });

  it('shows mismatch error when passwords differ', async () => {
    renderRp();
    const inputs = document.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'abc12345' } });
    fireEvent.change(inputs[1], { target: { value: 'xyz67890' } });
    fireEvent.click(screen.getByText('resetPassword.submit'));
    await waitFor(() => expect(screen.getByText('resetPassword.mismatch')).toBeInTheDocument());
    expect(postMock).not.toHaveBeenCalled();
  });

  it('submits password and navigates to /login on success', async () => {
    postMock.mockResolvedValue({});
    renderRp();
    const inputs = document.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'same' } });
    fireEvent.change(inputs[1], { target: { value: 'same' } });
    fireEvent.click(screen.getByText('resetPassword.submit'));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/auth/reset-password/abc123', { password: 'same' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/login'));
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('shows invalid-token error on API failure without message', async () => {
    postMock.mockRejectedValue({ response: { data: {} } });
    renderRp();
    const inputs = document.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'same' } });
    fireEvent.change(inputs[1], { target: { value: 'same' } });
    fireEvent.click(screen.getByText('resetPassword.submit'));
    await waitFor(() => expect(screen.getByText('resetPassword.invalidToken')).toBeInTheDocument());
  });

  it('shows server message if provided in error response', async () => {
    postMock.mockRejectedValue({ response: { data: { error: { message: 'bad token' } } } });
    renderRp();
    const inputs = document.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'same' } });
    fireEvent.change(inputs[1], { target: { value: 'same' } });
    fireEvent.click(screen.getByText('resetPassword.submit'));
    await waitFor(() => expect(screen.getByText('bad token')).toBeInTheDocument());
  });
});
