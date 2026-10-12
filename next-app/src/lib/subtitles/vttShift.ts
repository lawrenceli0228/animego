// Move every cue of a WebVTT document by a fixed amount: the "字幕延后 /
// 提前" control in the subtitle panel.
//
// Done on the text rather than with artplayer's `subtitleOffset`, which
// clamps to ±10 s, resets on every track switch and announces itself in a
// notice on each step. Shifting the text before the blob is made survives
// switches by construction and has no range limit.
//
// Positive `delaySec` shows subtitles later. A cue pushed wholly before 0 is
// dropped; one that straddles 0 starts at 0.

const TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})(.*)$/;

function parse(ts: string): number {
  const parts = ts.replace(",", ".").split(":");
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  return sec;
}

function format(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(r, 3)}`;
}

export function shiftVtt(vtt: string, delaySec: number): string {
  if (!delaySec) return vtt;
  const blocks = vtt.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => TIMING.test(l));
    if (i < 0) {
      out.push(block);
      continue;
    }
    const m = lines[i].match(TIMING)!;
    const start = parse(m[1]) + delaySec;
    const end = parse(m[2]) + delaySec;
    if (end <= 0) continue;
    lines[i] = `${format(Math.max(0, start))} --> ${format(end)}${m[3]}`;
    out.push(lines.join("\n"));
  }
  return out.join("\n\n");
}
