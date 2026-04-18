import { render } from '@testing-library/react';
import {
  AnimeGridSkeleton,
  DetailSkeleton,
  ProfileListSkeleton,
  SkeletonBox,
} from '../components/common/Skeleton';

describe('Skeleton', () => {
  it('SkeletonBox renders with default dimensions', () => {
    const { container } = render(<SkeletonBox />);
    const box = container.firstChild;
    expect(box.style.width).toBe('100%');
    expect(box.style.height).toBe('16px');
  });

  it('SkeletonBox respects custom width, height, radius', () => {
    const { container } = render(<SkeletonBox width={100} height={50} radius={4} />);
    const box = container.firstChild;
    expect(box.style.width).toBe('100px');
    expect(box.style.height).toBe('50px');
    expect(box.style.borderRadius).toBe('4px');
  });

  it('SkeletonBox merges additional style', () => {
    const { container } = render(<SkeletonBox style={{ marginTop: 10 }} />);
    expect(container.firstChild.style.marginTop).toBe('10px');
  });

  it('SkeletonBox injects shimmer keyframes once', () => {
    render(<SkeletonBox />);
    const styles = [...document.head.querySelectorAll('style')];
    const hasShimmer = styles.some(s => s.textContent?.includes('skeleton-shimmer'));
    expect(hasShimmer).toBe(true);
  });

  it('AnimeGridSkeleton renders default 10 placeholders', () => {
    const { container } = render(<AnimeGridSkeleton />);
    const grid = container.querySelector('.anime-grid-5col');
    expect(grid).toBeInTheDocument();
    expect(grid.children).toHaveLength(10);
  });

  it('AnimeGridSkeleton respects count prop', () => {
    const { container } = render(<AnimeGridSkeleton count={4} />);
    expect(container.querySelector('.anime-grid-5col').children).toHaveLength(4);
  });

  it('DetailSkeleton renders banner, cover, and section blocks', () => {
    const { container } = render(<DetailSkeleton />);
    // Has the main banner + cover + info blocks — just verify structure
    expect(container.querySelector('.container')).toBeInTheDocument();
    // Multiple skeleton blocks present
    const blocks = container.querySelectorAll('div[style*="skeleton-shimmer"]');
    expect(blocks.length).toBeGreaterThan(5);
  });

  it('ProfileListSkeleton renders default 6 cards', () => {
    const { container } = render(<ProfileListSkeleton />);
    const cards = container.firstChild.children;
    expect(cards).toHaveLength(6);
  });

  it('ProfileListSkeleton respects count prop', () => {
    const { container } = render(<ProfileListSkeleton count={3} />);
    expect(container.firstChild.children).toHaveLength(3);
  });
});
