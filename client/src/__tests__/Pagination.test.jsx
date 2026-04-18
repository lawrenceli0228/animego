import { render, screen, fireEvent } from '@testing-library/react';
import Pagination from '../components/common/Pagination';

describe('Pagination', () => {
  it('returns null when totalPages is 0', () => {
    const { container } = render(
      <Pagination page={1} totalPages={0} onPageChange={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null when totalPages is 1 (no pagination needed)', () => {
    const { container } = render(
      <Pagination page={1} totalPages={1} onPageChange={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders prev/next buttons and page indicator', () => {
    render(<Pagination page={2} totalPages={5} onPageChange={vi.fn()} />);
    expect(screen.getByText(/上一页/)).toBeInTheDocument();
    expect(screen.getByText(/下一页/)).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/\/ 5/)).toBeInTheDocument();
  });

  it('disables prev button on first page', () => {
    render(<Pagination page={1} totalPages={5} onPageChange={vi.fn()} />);
    expect(screen.getByText(/上一页/)).toBeDisabled();
    expect(screen.getByText(/下一页/)).not.toBeDisabled();
  });

  it('disables next button on last page', () => {
    render(<Pagination page={5} totalPages={5} onPageChange={vi.fn()} />);
    expect(screen.getByText(/下一页/)).toBeDisabled();
    expect(screen.getByText(/上一页/)).not.toBeDisabled();
  });

  it('calls onPageChange with page - 1 when prev clicked', () => {
    const onPageChange = vi.fn();
    render(<Pagination page={3} totalPages={5} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByText(/上一页/));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('calls onPageChange with page + 1 when next clicked', () => {
    const onPageChange = vi.fn();
    render(<Pagination page={3} totalPages={5} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByText(/下一页/));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });
});
