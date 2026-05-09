import { render, screen, fireEvent } from '@testing-library/react';
import LibraryEmptyState from '../components/library/LibraryEmptyState';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'library.addFolder': 'Add folder',
      'library.dropFolder': 'Drop folder here',
      'library.noSeries': 'No series yet — add a folder to get started.',
    }[key] || key),
  }),
}));

describe('LibraryEmptyState', () => {
  it('renders "Add folder" button when FSA is supported', () => {
    render(<LibraryEmptyState onAddFolder={vi.fn()} isFsaSupported={true} />);
    expect(screen.getByRole('button', { name: /add folder/i })).toBeInTheDocument();
  });

  it('calls onAddFolder when "Add folder" button is clicked', () => {
    const onAddFolder = vi.fn();
    render(<LibraryEmptyState onAddFolder={onAddFolder} isFsaSupported={true} />);
    fireEvent.click(screen.getByRole('button', { name: /add folder/i }));
    expect(onAddFolder).toHaveBeenCalledTimes(1);
  });

  it('renders "Drop folder here" text when FSA is not supported', () => {
    render(<LibraryEmptyState onAddFolder={vi.fn()} isFsaSupported={false} />);
    expect(screen.getByText('Drop folder here')).toBeInTheDocument();
  });

  it('does not show "Add folder" button when FSA is not supported', () => {
    render(<LibraryEmptyState onAddFolder={vi.fn()} isFsaSupported={false} />);
    expect(screen.queryByRole('button', { name: /add folder/i })).not.toBeInTheDocument();
  });
});
