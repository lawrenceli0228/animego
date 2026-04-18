import { render, screen, fireEvent } from '@testing-library/react';
import EpisodeNav from '../components/player/EpisodeNav';

describe('EpisodeNav', () => {
  it('renders a button per episode', () => {
    render(<EpisodeNav episodes={[1, 2, 3]} currentEpisode={1} onSelect={() => {}} />);
    expect(screen.getByText('EP01')).toBeInTheDocument();
    expect(screen.getByText('EP02')).toBeInTheDocument();
    expect(screen.getByText('EP03')).toBeInTheDocument();
  });

  it('pads episode numbers to 2 digits', () => {
    render(<EpisodeNav episodes={[1, 10, 100]} currentEpisode={1} onSelect={() => {}} />);
    expect(screen.getByText('EP01')).toBeInTheDocument();
    expect(screen.getByText('EP10')).toBeInTheDocument();
    expect(screen.getByText('EP100')).toBeInTheDocument();
  });

  it('calls onSelect when clicking a non-current episode', () => {
    const onSelect = vi.fn();
    render(<EpisodeNav episodes={[1, 2, 3]} currentEpisode={1} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('EP02'));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('does not call onSelect when clicking the current episode', () => {
    const onSelect = vi.fn();
    render(<EpisodeNav episodes={[1, 2, 3]} currentEpisode={2} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('EP02'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('applies active style to the current episode', () => {
    render(<EpisodeNav episodes={[1, 2]} currentEpisode={1} onSelect={() => {}} />);
    const btn = screen.getByText('EP01');
    expect(btn.style.background).toMatch(/rgb\(10, 132, 255\)|#0a84ff/i);
  });

  it('renders empty when episodes is empty', () => {
    const { container } = render(<EpisodeNav episodes={[]} currentEpisode={null} onSelect={() => {}} />);
    expect(container.querySelectorAll('button').length).toBe(0);
  });
});
