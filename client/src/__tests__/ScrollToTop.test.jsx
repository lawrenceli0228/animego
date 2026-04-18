import { render, act } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import ScrollToTop from '../components/common/ScrollToTop';

function Navigator({ to }) {
  const navigate = useNavigate();
  useEffect(() => { if (to) navigate(to); }, [to, navigate]);
  return null;
}

describe('ScrollToTop', () => {
  it('calls window.scrollTo(0, 0) on mount', () => {
    const scrollSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    render(
      <MemoryRouter initialEntries={['/a']}>
        <ScrollToTop />
      </MemoryRouter>
    );
    expect(scrollSpy).toHaveBeenCalledWith(0, 0);
    scrollSpy.mockRestore();
  });

  it('scrolls to top again when pathname changes', async () => {
    const scrollSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/a']}>
          <ScrollToTop />
          <Routes>
            <Route path="/a" element={<Navigator to="/b" />} />
            <Route path="/b" element={<div>B</div>} />
          </Routes>
        </MemoryRouter>
      );
    });
    expect(scrollSpy).toHaveBeenCalledTimes(2);
    scrollSpy.mockRestore();
  });

  it('renders nothing visible', () => {
    const { container } = render(
      <MemoryRouter>
        <ScrollToTop />
      </MemoryRouter>
    );
    expect(container.firstChild).toBeNull();
  });
});
