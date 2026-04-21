import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { Button } from '@/components/ui/button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });

  it('applies default variant + size classes', () => {
    render(<Button>x</Button>);
    const el = screen.getByRole('button');
    expect(el.className).toContain('bg-accent');
    expect(el.className).toContain('h-9');
  });

  it('switches to ghost variant', () => {
    render(<Button variant="ghost">x</Button>);
    const el = screen.getByRole('button');
    expect(el.className).not.toContain('bg-accent');
    expect(el.className).toContain('hover:bg-bg-elevated');
  });

  it('switches to sm size', () => {
    render(<Button size="sm">x</Button>);
    const el = screen.getByRole('button');
    expect(el.className).toContain('h-8');
  });

  it('merges custom className without breaking variant', () => {
    render(<Button className="w-full">x</Button>);
    const el = screen.getByRole('button');
    expect(el.className).toContain('w-full');
    expect(el.className).toContain('bg-accent');
  });

  it('forwards ref to the underlying button', () => {
    const ref = createRef();
    render(<Button ref={ref}>x</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('defaults type to button (prevents accidental form submit)', () => {
    render(<Button>x</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('fires onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>x</Button>);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        x
      </Button>
    );
    await user.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
