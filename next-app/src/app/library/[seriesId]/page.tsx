import dynamic from "next/dynamic";

// Same `ssr: false` strategy as /library — the shell touches Dexie
// and File System Access, both browser-only.

const LocalSeriesShell = dynamic(
  () =>
    import("../_components/LocalSeriesShell").then(
      (m) => m.LocalSeriesShell,
    ),
  { ssr: false, loading: SeriesSkeleton },
);

function SeriesSkeleton() {
  return (
    <div style={styles.skeleton}>
      <div style={styles.skeletonHeader} />
      <div style={styles.skeletonList}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} style={styles.skeletonRow} />
        ))}
      </div>
    </div>
  );
}

interface PageProps {
  params: Promise<{ seriesId: string }>;
}

export default async function LocalSeriesPage({ params }: PageProps) {
  const { seriesId } = await params;
  return <LocalSeriesShell seriesId={seriesId} />;
}

const styles: Record<string, React.CSSProperties> = {
  skeleton: {
    minHeight: "100vh",
    background: "#0b0b10",
    padding: 32,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  skeletonHeader: {
    height: 80,
    background: "#15151f",
    borderRadius: 8,
  },
  skeletonList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  skeletonRow: {
    height: 48,
    background: "#15151f",
    borderRadius: 6,
  },
};
