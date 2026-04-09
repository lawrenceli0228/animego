/**
 * Reusable skeleton building blocks + preset layouts.
 * Uses a single @keyframes shimmer injected once.
 */

const shimmerCSS = `
@keyframes skeleton-shimmer {
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
}
`;
let injected = false;
function injectShimmer() {
  if (injected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = shimmerCSS;
  document.head.appendChild(style);
  injected = true;
}

const baseStyle = {
  background: 'linear-gradient(90deg, #1c1c1e 25%, #2c2c2e 50%, #1c1c1e 75%)',
  backgroundSize: '800px 100%',
  animation: 'skeleton-shimmer 1.6s ease-in-out infinite',
  borderRadius: 8,
};

function Box({ width, height, radius, style }) {
  injectShimmer();
  return (
    <div style={{
      ...baseStyle,
      width: width || '100%',
      height: height || 16,
      borderRadius: radius ?? 8,
      flexShrink: 0,
      ...style,
    }} />
  );
}

/** Grid of anime card skeletons (matches AnimeGrid 5-col layout) */
export function AnimeGridSkeleton({ count = 10 }) {
  return (
    <>
      <div className="anime-grid-5col" style={{
        display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12,
      }}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} style={{
            borderRadius: 12, overflow: 'hidden',
            border: '1px solid #38383a', aspectRatio: '3/4',
          }}>
            <Box width="100%" height="100%" radius={0} />
          </div>
        ))}
      </div>
      <style>{`
        @media (max-width: 900px) {
          .anime-grid-5col { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 600px) {
          .anime-grid-5col { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
    </>
  );
}

/** Detail page hero + info skeleton */
export function DetailSkeleton() {
  return (
    <div>
      {/* Banner */}
      <Box width="100%" height={280} radius={0} />
      <div className="container" style={{ paddingTop: 24 }}>
        <div style={{ display: 'flex', gap: 24 }}>
          {/* Cover */}
          <Box width={180} height={260} radius={10} style={{ marginTop: -80 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}>
            <Box height={28} width="60%" />
            <Box height={16} width="40%" />
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <Box width={60} height={26} radius={13} />
              <Box width={60} height={26} radius={13} />
              <Box width={80} height={26} radius={13} />
            </div>
            <Box height={14} width="90%" style={{ marginTop: 8 }} />
            <Box height={14} width="75%" />
            <Box height={14} width="60%" />
          </div>
        </div>
        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <Box width={150} height={40} radius={8} />
          <Box width={80} height={40} radius={8} />
          <Box width={80} height={40} radius={8} />
        </div>
        {/* Sections */}
        <Box height={20} width={120} style={{ marginTop: 40 }} />
        <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} style={{ textAlign: 'center' }}>
              <Box width={64} height={64} radius={32} />
              <Box width={56} height={12} style={{ marginTop: 8 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Profile list item skeleton (matches ProfilePage grid cards) */
export function ProfileListSkeleton({ count = 6 }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
      gap: 12,
    }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{
          display: 'flex', gap: 12, padding: 12, borderRadius: 10,
          background: '#1c1c1e', border: '1px solid #38383a',
        }}>
          <Box width={56} height={80} radius={6} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
            <Box height={14} width="70%" />
            <Box height={11} width="45%" />
          </div>
        </div>
      ))}
    </div>
  );
}

export { Box as SkeletonBox };
