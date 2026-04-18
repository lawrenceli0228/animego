import { render, screen, fireEvent } from '@testing-library/react';
import SeasonSelector from '../components/season/SeasonSelector';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => {
      if (key === 'season.year') return 'yr';
      return key.replace(/^season\./, '');
    },
  }),
}));

describe('SeasonSelector', () => {
  it('renders year dropdown with current-year-ish values', () => {
    render(
      <SeasonSelector year={2025} season="SPRING" onYearChange={vi.fn()} onSeasonChange={vi.fn()} />
    );
    const select = screen.getByDisplayValue(/2025/);
    expect(select).toBeInTheDocument();
  });

  it('renders the 4 season tabs', () => {
    render(
      <SeasonSelector year={2025} season="SPRING" onYearChange={vi.fn()} onSeasonChange={vi.fn()} />
    );
    expect(screen.getByText('WINTER')).toBeInTheDocument();
    expect(screen.getByText('SPRING')).toBeInTheDocument();
    expect(screen.getByText('SUMMER')).toBeInTheDocument();
    expect(screen.getByText('FALL')).toBeInTheDocument();
  });

  it('calls onYearChange with a numeric year', () => {
    const onYearChange = vi.fn();
    render(
      <SeasonSelector year={2025} season="SPRING" onYearChange={onYearChange} onSeasonChange={vi.fn()} />
    );
    fireEvent.change(screen.getByDisplayValue(/2025/), { target: { value: '2023' } });
    expect(onYearChange).toHaveBeenCalledWith(2023);
    expect(typeof onYearChange.mock.calls[0][0]).toBe('number');
  });

  it('calls onSeasonChange with the season value', () => {
    const onSeasonChange = vi.fn();
    render(
      <SeasonSelector year={2025} season="SPRING" onYearChange={vi.fn()} onSeasonChange={onSeasonChange} />
    );
    fireEvent.click(screen.getByText('SUMMER'));
    expect(onSeasonChange).toHaveBeenCalledWith('SUMMER');
  });

  it('highlights the active season', () => {
    render(
      <SeasonSelector year={2025} season="FALL" onYearChange={vi.fn()} onSeasonChange={vi.fn()} />
    );
    const fall = screen.getByText('FALL');
    const winter = screen.getByText('WINTER');
    expect(fall.style.background).toContain('10, 132, 255');
    expect(winter.style.background).not.toContain('10, 132, 255');
  });
});
