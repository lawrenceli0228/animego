import { render, screen } from '@testing-library/react';
import CharacterSection from '../components/anime/CharacterSection';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ lang: 'en' }),
}));

describe('CharacterSection', () => {
  it('renders nothing for empty characters', () => {
    const { container } = render(<CharacterSection characters={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when characters is undefined', () => {
    const { container } = render(<CharacterSection />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "Characters" header', () => {
    render(<CharacterSection characters={[{ nameJa: 'A' }]} />);
    expect(screen.getByText('Characters')).toBeInTheDocument();
  });

  it('renders each character with Japanese name preference', () => {
    render(<CharacterSection characters={[
      { nameJa: '主角ジャ', nameEn: 'Main EN', role: 'MAIN' },
      { nameJa: null, nameEn: 'Sub EN', role: 'SUPPORTING' },
    ]} />);
    expect(screen.getByText('主角ジャ')).toBeInTheDocument();
    expect(screen.getByText('Sub EN')).toBeInTheDocument();
  });

  it('maps role codes to labels', () => {
    render(<CharacterSection characters={[
      { nameJa: 'X', role: 'MAIN' },
      { nameJa: 'Y', role: 'SUPPORTING' },
      { nameJa: 'Z', role: 'BACKGROUND' },
    ]} />);
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByText('Supporting')).toBeInTheDocument();
    expect(screen.getByText('Background')).toBeInTheDocument();
  });

  it('shows VA name with language label when provided', () => {
    render(<CharacterSection characters={[
      { nameJa: 'Char', voiceActorJa: 'VA-Ja', role: 'MAIN' },
    ]} />);
    expect(screen.getByText('VA-Ja')).toBeInTheDocument();
    expect(screen.getByText('Japanese')).toBeInTheDocument();
  });

  it('omits VA block when no voice actor present', () => {
    render(<CharacterSection characters={[
      { nameJa: 'Char', role: 'MAIN' },
    ]} />);
    expect(screen.queryByText('Japanese')).not.toBeInTheDocument();
  });

  it('renders portrait image when imageUrl present', () => {
    const { container } = render(<CharacterSection characters={[
      { nameJa: 'Char', imageUrl: 'char.jpg', voiceActorJa: 'VA', voiceActorImageUrl: 'va.jpg', role: 'MAIN' },
    ]} />);
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    expect(imgs[0].src).toContain('char.jpg');
    expect(imgs[1].src).toContain('va.jpg');
  });

  it('falls back to em-dash when no name fields given', () => {
    render(<CharacterSection characters={[{ role: 'MAIN' }]} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
