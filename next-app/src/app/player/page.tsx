"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";

// PlayerShell is the entire Player surface — artplayer + jassub +
// danmaku + episode list — all of which is 100 % browser-DOM. ssr:
// false skips the SSR pass entirely. proxy.ts (P6.1) and the
// layout.tsx auth gate run before this.
//
// PlayerShell itself reads useSearchParams() inside, which needs a
// Suspense boundary at the page level when used in Client Components
// (Next 16 contract).
const PlayerShell = dynamic(
  () => import("./_components/PlayerShell").then((m) => m.PlayerShell),
  { ssr: false, loading: PlayerSkeleton },
);

function PlayerSkeleton() {
  return (
    <div style={styles.skeleton}>
      <div style={styles.skeletonVideo}>
        <div style={styles.skeletonSpinner}>正在加载播放器…</div>
      </div>
    </div>
  );
}

export default function PlayerPage() {
  return (
    <Suspense fallback={<PlayerSkeleton />}>
      <PlayerShell />
    </Suspense>
  );
}

const styles: Record<string, React.CSSProperties> = {
  skeleton: {
    minHeight: "100vh",
    background: "#0b0b10",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  skeletonVideo: {
    width: "100%",
    maxWidth: 1280,
    aspectRatio: "16/9",
    background: "#15151f",
    border: "1px solid #1f1f2a",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  skeletonSpinner: {
    color: "#7c7c8c",
    fontSize: 14,
  },
};
