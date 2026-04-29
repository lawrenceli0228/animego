import { render, screen, fireEvent } from '@testing-library/react';
import FsaUnsupportedBanner from '../components/library/FsaUnsupportedBanner';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'library.unsupportedBanner': 'Your browser does not keep libraries between sessions.',
    }[key] || key),
  }),
}));

describe('FsaUnsupportedBanner', () => {
  it('renders the warning message', () => {
    render(<FsaUnsupportedBanner />);
    expect(
      screen.getByText('Your browser does not keep libraries between sessions.')
    ).toBeInTheDocument();
  });

  it('renders a dismiss button when onDismiss is provided', () => {
    render(<FsaUnsupportedBanner onDismiss={vi.fn()} />);
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<FsaUnsupportedBanner onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not render dismiss button when onDismiss is not provided', () => {
    render(<FsaUnsupportedBanner />);
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });
});
