import { render, screen, fireEvent } from '@testing-library/react';
import EpisodeFileList from '../components/player/EpisodeFileList';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => key,
    lang: 'en',
  }),
}));

vi.mock('../utils/formatters', () => ({
  formatScore: (v) => String(v),
}));

const anime = {
  titleNative: 'Sample Show',
  titleChinese: '样本',
  titleRomaji: 'Sample Show',
  coverImageUrl: 'https://example.com/cover.jpg',
  episodes: 12,
};

const videoFiles = [
  { fileName: 'show-01.mkv', episode: 1 },
  { fileName: 'show-02.mkv', episode: 2 },
  { fileName: 'unknown.mkv', episode: null },
];

const episodeMap = {
  1: { title: 'Beginning', dandanEpisodeId: 111 },
  2: { title: 'Middle', dandanEpisodeId: 222 },
};

function renderList(overrides = {}) {
  const props = {
    anime,
    siteAnime: null,
    episodeMap,
    videoFiles,
    onPlay: vi.fn(),
    onClear: vi.fn(),
    onSetDanmaku: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<EpisodeFileList {...props} />) };
}

describe('EpisodeFileList — header', () => {
  it('renders native and Chinese titles plus episode count', () => {
    renderList();
    expect(screen.getByText('Sample Show')).toBeInTheDocument();
    expect(screen.getByText('样本')).toBeInTheDocument();
    expect(screen.getByText(/12/)).toBeInTheDocument();
  });

  it('renders the cover image only when coverImageUrl is present', () => {
    const { rerender } = renderList();
    expect(document.querySelector('img[src="https://example.com/cover.jpg"]')).toBeInTheDocument();

    rerender(
      <EpisodeFileList
        anime={{ ...anime, coverImageUrl: null }}
        siteAnime={null}
        episodeMap={episodeMap}
        videoFiles={videoFiles}
        onPlay={vi.fn()}
        onClear={vi.fn()}
        onSetDanmaku={vi.fn()}
      />
    );
    expect(document.querySelector('img[src="https://example.com/cover.jpg"]')).not.toBeInTheDocument();
  });

  it('shows the mapped-count badge reflecting episodeMap size', () => {
    renderList();
    expect(screen.getByText(/dandanplay/)).toBeInTheDocument();
    expect(screen.getByText(/2\s+player\.mapped/)).toBeInTheDocument();
  });

  it('invokes onClear when the clear button is clicked', () => {
    const onClear = vi.fn();
    renderList({ onClear });
    fireEvent.click(screen.getByText(/player\.clear/));
    expect(onClear).toHaveBeenCalled();
  });
});

describe('EpisodeFileList — siteAnime info', () => {
  it('renders scores, format, status, and genres when siteAnime is provided', () => {
    renderList({
      siteAnime: {
        anilistId: 42,
        averageScore: 82,
        bangumiScore: 8.5,
        bangumiVotes: 1234,
        format: 'TV',
        status: 'FINISHED',
        episodes: 12,
        season: 'SPRING',
        seasonYear: 2024,
        studios: ['Studio A', 'Studio B'],
        source: 'MANGA',
        duration: 24,
        genres: ['Action', 'Drama'],
      },
    });

    expect(screen.getByText(/82/)).toBeInTheDocument();
    expect(screen.getByText(/8\.5/)).toBeInTheDocument();
    expect(screen.getByText('TV')).toBeInTheDocument();
    expect(screen.getByText('Studio A · Studio B')).toBeInTheDocument();
    expect(screen.getByText('Action')).toBeInTheDocument();
    expect(screen.getByText('Drama')).toBeInTheDocument();
    expect(screen.getByText(/detail\.viewDetails/)).toBeInTheDocument();
  });

  it('does not render the siteInfo block when siteAnime is null', () => {
    renderList({ siteAnime: null });
    expect(screen.queryByText(/detail\.viewDetails/)).not.toBeInTheDocument();
  });
});

describe('EpisodeFileList — episode rows', () => {
  it('renders an EPxx label for episodes with a number and — for unknown', () => {
    renderList();
    expect(screen.getByText('EP01')).toBeInTheDocument();
    expect(screen.getByText('EP02')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows matched episode titles from episodeMap', () => {
    renderList();
    expect(screen.getByText('Beginning')).toBeInTheDocument();
    expect(screen.getByText('Middle')).toBeInTheDocument();
  });

  it('calls onPlay with the file when a row is clicked', () => {
    const onPlay = vi.fn();
    renderList({ onPlay });
    fireEvent.click(screen.getByText('show-01.mkv'));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'show-01.mkv' }));
  });

  it('calls onSetDanmaku with the episode number and does NOT trigger onPlay', () => {
    const onPlay = vi.fn();
    const onSetDanmaku = vi.fn();
    renderList({ onPlay, onSetDanmaku });

    const danmakuBtns = screen.getAllByLabelText('Set danmaku');
    fireEvent.click(danmakuBtns[0]);

    expect(onSetDanmaku).toHaveBeenCalledWith(1);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('triggers onPlay when Enter is pressed on a focused row', () => {
    const onPlay = vi.fn();
    renderList({ onPlay });
    const row = screen.getByText('show-02.mkv').closest('[role="button"]');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'show-02.mkv' }));
  });
});

describe('EpisodeFileList — siteAnime skeleton', () => {
  it('renders skeleton when siteAnime is null AND siteAnimeLoading is true', () => {
    renderList({ siteAnime: null, siteAnimeLoading: true });
    expect(screen.getByTestId('site-anime-skeleton')).toBeInTheDocument();
  });

  it('omits skeleton when siteAnime is present (real data wins)', () => {
    renderList({
      siteAnime: { averageScore: 80, format: 'TV' },
      siteAnimeLoading: true,
    });
    expect(screen.queryByTestId('site-anime-skeleton')).toBeNull();
  });

  it('omits skeleton when not loading and siteAnime is null (no rich data available)', () => {
    renderList({ siteAnime: null, siteAnimeLoading: false });
    expect(screen.queryByTestId('site-anime-skeleton')).toBeNull();
  });

  it('omits skeleton by default (backwards compatible — drop-zone match flow never sets the prop)', () => {
    renderList({ siteAnime: null });
    expect(screen.queryByTestId('site-anime-skeleton')).toBeNull();
  });
});
