import dynamic from "next/dynamic";

// `ssr: false` makes Next skip the server pass entirely for this
// page. Required because LibraryShell touches Dexie + File System
// Access at the top of its render tree — both are window-only.
// Without this opt-out, the SSR pass would import @/lib/library/db
// and hit the server-only guard in db.js (P6.2).
//
// The route still hits proxy.ts and the layout.tsx auth gate before
// reaching this dynamic-loaded shell, so unauthenticated traffic
// never gets here.
const LibraryShell = dynamic(
  () => import("./_components/LibraryShell").then((m) => m.LibraryShell),
  { ssr: false, loading: LibrarySkeleton },
);

function LibrarySkeleton() {
  return (
    <div style={styles.skeleton}>
      <div style={styles.skeletonBar} />
      <div style={styles.skeletonGrid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={styles.skeletonCard} />
        ))}
      </div>
    </div>
  );
}

export default function LibraryPage() {
  return <LibraryShell />;
}

const styles: Record<string, React.CSSProperties> = {
  skeleton: {
    minHeight: "100vh",
    background: "#0b0b10",
    padding: 32,
    display: "flex",
    flexDirection: "column",
    gap: 24,
  },
  skeletonBar: {
    height: 40,
    width: 200,
    background: "#15151f",
    borderRadius: 8,
  },
  skeletonGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: 16,
  },
  skeletonCard: {
    aspectRatio: "2/3",
    background: "#15151f",
    borderRadius: 8,
  },
};
