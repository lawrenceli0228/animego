import { render, screen, fireEvent } from '@testing-library/react';
import MatchProgress from '../components/player/MatchProgress';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (k) => ({
      'player.stepParse': 'Parse',
      'player.stepMatch': 'Match',
      'player.stepMap': 'Map',
      'player.videos': 'videos',
      'player.keyword': 'keyword',
      'player.loaded': 'Loaded',
      'player.clear': 'Clear',
    }[k] || k),
  }),
}));

describe('MatchProgress', () => {
  it('shows header with file count and clear button', () => {
    render(<MatchProgress fileCount={3} keyword="One Piece" stepStatus={{}} onClear={() => {}} />);
    expect(screen.getByText(/Loaded:.*3.*videos/)).toBeInTheDocument();
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('renders all three step labels', () => {
    render(<MatchProgress fileCount={1} keyword="k" stepStatus={{}} onClear={() => {}} />);
    expect(screen.getByText(/Parse/)).toBeInTheDocument();
    expect(screen.getByText(/Match/)).toBeInTheDocument();
    expect(screen.getByText(/Map/)).toBeInTheDocument();
  });

  it('shows pending ○ for steps with no status', () => {
    const { container } = render(<MatchProgress fileCount={1} keyword="k" stepStatus={{}} onClear={() => {}} />);
    const icons = container.querySelectorAll('div[style*="height: 40px"] span');
    expect(icons[0].textContent).toBe('○');
  });

  it('shows done ✓ icon with detail appended', () => {
    render(<MatchProgress fileCount={3} keyword="One Piece" stepStatus={{ 1: 'done' }} onClear={() => {}} />);
    expect(screen.getByText(/Parse.*—.*3.*One Piece/)).toBeInTheDocument();
  });

  it('shows active ◌ icon with ellipsis', () => {
    render(<MatchProgress fileCount={1} keyword="k" stepStatus={{ 2: 'active' }} onClear={() => {}} />);
    expect(screen.getByText(/Match \.\.\./)).toBeInTheDocument();
  });

  it('shows fail ✕ icon', () => {
    const { container } = render(<MatchProgress fileCount={1} keyword="k" stepStatus={{ 3: 'fail' }} onClear={() => {}} />);
    expect(container.textContent).toContain('✕');
  });

  it('calls onClear when clear button clicked', () => {
    const onClear = vi.fn();
    render(<MatchProgress fileCount={1} keyword="k" stepStatus={{}} onClear={onClear} />);
    fireEvent.click(screen.getByText('Clear'));
    expect(onClear).toHaveBeenCalled();
  });

  it('marks active step with aria-live="polite"', () => {
    const { container } = render(<MatchProgress fileCount={1} keyword="k" stepStatus={{ 2: 'active' }} onClear={() => {}} />);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
  });
});
