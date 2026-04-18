import { render, screen } from '@testing-library/react';
import StaffSection from '../components/anime/StaffSection';

let lang = 'en';
vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ lang }),
}));

describe('StaffSection', () => {
  beforeEach(() => { lang = 'en'; });

  it('renders nothing for empty list', () => {
    const { container } = render(<StaffSection staff={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when staff undefined', () => {
    const { container } = render(<StaffSection />);
    expect(container.firstChild).toBeNull();
  });

  it('renders Staff header in English', () => {
    render(<StaffSection staff={[{ nameEn: 'A', role: 'Director' }]} />);
    expect(screen.getByText('Staff')).toBeInTheDocument();
  });

  it('renders Chinese header when lang=zh', () => {
    lang = 'zh';
    render(<StaffSection staff={[{ nameJa: 'A' }]} />);
    expect(screen.getByText('制作人员')).toBeInTheDocument();
  });

  it('prefers English name when lang=en', () => {
    render(<StaffSection staff={[{ nameEn: 'Eng', nameJa: 'Jpn' }]} />);
    expect(screen.getByText('Eng')).toBeInTheDocument();
    expect(screen.queryByText('Jpn')).not.toBeInTheDocument();
  });

  it('prefers Japanese name when lang=zh and Japanese provided', () => {
    lang = 'zh';
    render(<StaffSection staff={[{ nameEn: 'Eng', nameJa: 'Jpn' }]} />);
    expect(screen.getByText('Jpn')).toBeInTheDocument();
  });

  it('renders role below name when provided', () => {
    render(<StaffSection staff={[{ nameEn: 'A', role: 'Director' }]} />);
    expect(screen.getByText('Director')).toBeInTheDocument();
  });

  it('renders image when imageUrl present', () => {
    const { container } = render(<StaffSection staff={[{ nameEn: 'A', imageUrl: 'a.jpg' }]} />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img.src).toContain('a.jpg');
  });

  it('falls back to em-dash when no name', () => {
    render(<StaffSection staff={[{ role: 'Unknown' }]} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
