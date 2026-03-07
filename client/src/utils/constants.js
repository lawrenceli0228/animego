export const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

export const SEASON_LABELS = {
  WINTER: '冬季 ❄️',
  SPRING: '春季 🌸',
  SUMMER: '夏季 ☀️',
  FALL:   '秋季 🍂'
};

export const STATUS_OPTIONS = [
  { value: 'watching',      label: '在看',   color: '#3b82f6' },
  { value: 'completed',     label: '看完',   color: '#22c55e' },
  { value: 'plan_to_watch', label: '想看',   color: '#a855f7' },
  { value: 'dropped',       label: '放弃',   color: '#ef4444' }
];

export function getCurrentSeason() {
  const m = new Date().getMonth() + 1;
  if (m <= 3)  return 'WINTER';
  if (m <= 6)  return 'SPRING';
  if (m <= 9)  return 'SUMMER';
  return 'FALL';
}

export const GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy',
  'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological',
  'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'
];
