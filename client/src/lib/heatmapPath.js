/**
 * heatmapPath — pure helpers that re-implement the artplayer-plugin-danmuku
 * heatmap path math so the HeatmapTuner panel can apply Group B knobs
 * (sampling/smoothing/flattening/scale/minHeight) live without re-initializing
 * the plugin.
 *
 * Faithfully ported from the plugin source. Plugin-baked defaults that don't
 * appear here (xMin=0, xMax=width, yMin=0, yMax=128) are inlined so output
 * matches the plugin's stock visuals at the same knob values.
 */

const DEFAULTS = {
  sampling: 3,
  smoothing: 0.5,
  flattening: 0.4,
  scale: 0.18,
  minHeight: 3,
  width: 800,
  height: 100,
  // Upper bound for Y-axis normalization. Plugin hardcodes 128, but most anime
  // episodes have max bucket count well below that, so peaks get pressed flat
  // against the band's bottom. Pass a per-episode value (e.g. max(count) * 1.18)
  // for honest peaks.
  yMax: 128,
};

function mapRange(value, inMin, inMax, outMin, outMax) {
  return ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
}

function line(pointA, pointB) {
  const lengthX = pointB[0] - pointA[0];
  const lengthY = pointB[1] - pointA[1];
  return {
    length: Math.sqrt(lengthX ** 2 + lengthY ** 2),
    angle: Math.atan2(lengthY, lengthX),
  };
}

function controlPoint(current, previous, next, smoothing, flattening, reverse) {
  const p = previous || current;
  const n = next || current;
  const o = line(p, n);
  const flat = mapRange(Math.cos(o.angle) * flattening, 0, 1, 1, 0);
  const angle = o.angle * flat + (reverse ? Math.PI : 0);
  const length = o.length * smoothing;
  const x = current[0] + Math.cos(angle) * length;
  const y = current[1] + Math.sin(angle) * length;
  return [x, y];
}

function bezierCommand(point, i, a, smoothing, flattening) {
  const cps = controlPoint(a[i - 1], a[i - 2], point, smoothing, flattening, false);
  const cpe = controlPoint(point, a[i - 1], a[i + 1], smoothing, flattening, true);
  const close = i === a.length - 1 ? ' z' : '';
  return `C ${cps[0]},${cps[1]} ${cpe[0]},${cpe[1]} ${point[0]},${point[1]}${close}`;
}

export function buildHeatmapPath(comments, duration, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const { width: w, height: h, sampling, smoothing, flattening, scale, minHeight, yMax } = o;

  if (!duration || !w || !h) return '';

  const list = Array.isArray(comments) ? comments : [];
  const gap = duration / w;

  const points = [];
  for (let x = 0; x <= w; x += sampling) {
    const lo = x * gap;
    const hi = (x + sampling) * gap;
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i] && list[i].time;
      if (typeof t === 'number' && t > lo && t <= hi) count += 1;
    }
    points.push([x, count]);
  }

  if (points.length === 0) return '';

  const last = points[points.length - 1];
  if (last[0] !== w) points.push([w, last[1]]);

  const ys = points.map((p) => p[1]);
  const yLo = Math.min(...ys);
  const yHi = Math.max(...ys);
  const yMid = (yLo + yHi) / 2;
  for (let i = 0; i < points.length; i++) {
    const y = points[i][1];
    points[i][1] = y * (y > yMid ? 1 + scale : 1 - scale) + minHeight;
  }

  const positions = points.map(([x, y]) => [
    mapRange(x, 0, w, 0, w),
    mapRange(y, 0, yMax, h, 0),
  ]);

  return positions.reduce((acc, e, i, a) => {
    if (i === 0) {
      return `M ${a[a.length - 1][0]},${h} L ${e[0]},${h} L ${e[0]},${e[1]}`;
    }
    return `${acc} ${bezierCommand(e, i, a, smoothing, flattening)}`;
  }, '');
}

export function getHeatmapPathTarget(art) {
  if (!art) return null;
  const player = art.template && art.template.$player;
  if (!player || typeof player.querySelector !== 'function') return null;
  return player.querySelector('.art-control-heatmap path') || null;
}

/**
 * Apply a heatmap path to the plugin's <path> element using a per-episode
 * dynamic yMax so peaks fill the band instead of being squashed to the bottom
 * by the plugin's hardcoded yMax=128. Single source of truth: VideoPlayer
 * (production) and HeatmapTuner (live tuning) both call this so what you see
 * in the tuner is what production renders.
 */
export function applyHeatmapPath(art, opts) {
  const danmuku = art && art.plugins && art.plugins.artplayerPluginDanmuku;
  const queue = (danmuku && danmuku.queue) || [];
  const duration = Number(art && art.duration);
  if (!queue.length || !duration || !Number.isFinite(duration)) {
    return { ok: false, reason: !queue.length ? 'queue empty' : 'no duration', queueLen: queue.length };
  }
  const pathEl = getHeatmapPathTarget(art);
  if (!pathEl) return { ok: false, reason: 'no <path> el', queueLen: queue.length };
  const svg = pathEl.ownerSVGElement;
  const vb = svg && svg.viewBox && svg.viewBox.baseVal;
  const width = (vb && vb.width) || (svg && svg.clientWidth) || 0;
  const height = (vb && vb.height) || (svg && svg.clientHeight) || 0;
  if (!width || !height) return { ok: false, reason: 'no svg size', queueLen: queue.length };

  const gap = duration / width;
  let maxCount = 0;
  for (let x = 0; x <= width; x += opts.sampling) {
    let count = 0;
    const lo = x * gap;
    const hi = (x + opts.sampling) * gap;
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i] && queue[i].time;
      if (typeof t === 'number' && t > lo && t <= hi) count += 1;
    }
    if (count > maxCount) maxCount = count;
  }
  if (maxCount === 0) return { ok: false, reason: 'all buckets empty', queueLen: queue.length };
  // No headroom: peaks reach exactly the top of the band so the visible area
  // fills upward from progress bar with no empty gap.
  const peak = maxCount * (1 + opts.scale) + opts.minHeight;
  const yMax = Math.max(1, peak);

  const d = buildHeatmapPath(queue, duration, { ...opts, width, height, yMax });
  if (d) pathEl.setAttribute('d', d);
  return {
    ok: Boolean(d),
    reason: d ? null : 'empty path',
    queueLen: queue.length,
    width: Math.round(width),
    height: Math.round(height),
    pathLen: d ? d.length : 0,
  };
}
