import { render, screen, fireEvent, act } from '@testing-library/react';
import SearchBar from '../components/search/SearchBar';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => key === 'search.placeholder' ? 'Search...' : key,
  }),
}));

describe('SearchBar', () => {
  it('renders with initial value', () => {
    render(<SearchBar value="foo" onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('foo')).toBeInTheDocument();
  });

  it('uses translated placeholder', () => {
    render(<SearchBar value="" onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
  });

  it('debounces onChange by 400ms', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<SearchBar value="" onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('Search...'), {
      target: { value: 'a' },
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(250); });
    expect(onChange).toHaveBeenCalledWith('a');
    vi.useRealTimers();
  });

  it('cancels pending debounce when value changes again', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<SearchBar value="" onChange={onChange} />);
    const input = screen.getByPlaceholderText('Search...');
    fireEvent.change(input, { target: { value: 'a' } });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.change(input, { target: { value: 'ab' } });
    act(() => { vi.advanceTimersByTime(400); });
    // Only one call, with the latest value
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('ab');
    vi.useRealTimers();
  });

  it('syncs local state when controlled value prop changes', () => {
    const { rerender } = render(<SearchBar value="a" onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('a')).toBeInTheDocument();
    rerender(<SearchBar value="b" onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('b')).toBeInTheDocument();
  });

  it('does not call onChange if local matches prop value', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<SearchBar value="same" onChange={onChange} />);
    act(() => { vi.advanceTimersByTime(500); });
    expect(onChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('focus/blur toggles border color', () => {
    render(<SearchBar value="" onChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search...');
    fireEvent.focus(input);
    expect(input.style.borderColor).toBe('rgb(10, 132, 255)');
    fireEvent.blur(input);
    expect(input.style.borderColor).not.toBe('rgb(10, 132, 255)');
  });
});
