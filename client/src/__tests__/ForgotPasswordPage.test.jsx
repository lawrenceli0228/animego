import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ForgotPasswordPage from '../pages/ForgotPasswordPage';

const postMock = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('../api/axiosClient', () => ({
  default: { post: (...a) => postMock(...a) },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: (m) => toastSuccess(m), error: (m) => toastError(m) },
}));

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ t: (k) => k }),
}));

function renderFp() {
  return render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);
}

beforeEach(() => {
  postMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('ForgotPasswordPage', () => {
  it('renders title and email input', () => {
    renderFp();
    expect(screen.getByText('forgotPassword.title')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('submits email and shows success state', async () => {
    postMock.mockResolvedValue({});
    renderFp();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByText('forgotPassword.submit'));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/auth/forgot-password', { email: 'a@b.com' }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it('shows error toast on failure', async () => {
    postMock.mockRejectedValue(new Error('boom'));
    renderFp();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x@y.com' } });
    fireEvent.click(screen.getByText('forgotPassword.submit'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('shows back-to-login link', () => {
    renderFp();
    expect(screen.getByText('forgotPassword.backToLogin')).toBeInTheDocument();
  });

  it('disables submit button while loading', async () => {
    let resolveIt;
    postMock.mockReturnValue(new Promise((r) => { resolveIt = r; }));
    renderFp();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByText('forgotPassword.submit'));
    await waitFor(() => expect(screen.getByText('forgotPassword.submitting')).toBeInTheDocument());
    resolveIt({});
  });
});
