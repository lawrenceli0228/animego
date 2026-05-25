"use client";
// P6.6 placeholder — real port lands with the Player subagent fan-out.
// Library's LocalSeriesShell imports this to render the episode list
// after a series is opened. For now this is a stub so the build resolves.

export interface EpisodeFileListProps {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  [key: string]: any;
}

export function EpisodeFileList(_props: EpisodeFileListProps) {
  return (
    <div style={{ padding: 32, color: "#9090a0", textAlign: "center" }}>
      EpisodeFileList placeholder — P6.6 ports the real component.
    </div>
  );
}
