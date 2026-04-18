import { render, screen, fireEvent } from '@testing-library/react';
import GenreFilter from '../components/search/GenreFilter';
import { GENRES } from '../utils/constants';

describe('GenreFilter', () => {
  it('renders a button for each genre', () => {
    render(<GenreFilter selected="" onSelect={vi.fn()} />);
    GENRES.forEach(g => {
      expect(screen.getByText(g)).toBeInTheDocument();
    });
  });

  it('calls onSelect with genre when an inactive genre is clicked', () => {
    const onSelect = vi.fn();
    render(<GenreFilter selected="" onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Action'));
    expect(onSelect).toHaveBeenCalledWith('Action');
  });

  it('calls onSelect with empty string when the active genre is clicked (toggle off)', () => {
    const onSelect = vi.fn();
    render(<GenreFilter selected="Romance" onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Romance'));
    expect(onSelect).toHaveBeenCalledWith('');
  });

  it('applies active style to selected genre', () => {
    render(<GenreFilter selected="Comedy" onSelect={vi.fn()} />);
    const active = screen.getByText('Comedy');
    const inactive = screen.getByText('Drama');
    // Active gets the brand blue color
    expect(active.style.color).toBe('rgb(10, 132, 255)');
    expect(inactive.style.color).not.toBe('rgb(10, 132, 255)');
  });
});
