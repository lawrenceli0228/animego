import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Layout from '../components/layout/Layout';

vi.mock('../components/layout/Navbar', () => ({
  default: () => <div data-testid="navbar" />,
}));

vi.mock('../components/layout/Footer', () => ({
  default: () => <div data-testid="footer" />,
}));

describe('Layout', () => {
  it('renders Navbar, Footer, and Outlet content', () => {
    render(
      <MemoryRouter initialEntries={['/child']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/child" element={<div data-testid="outlet">Child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId('navbar')).toBeInTheDocument();
    expect(screen.getByTestId('footer')).toBeInTheDocument();
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });

  it('wraps outlet in a <main> element', () => {
    const { container } = render(
      <MemoryRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<div>X</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(container.querySelector('main')).toBeInTheDocument();
  });
});
