export const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

export const STATUS_OPTIONS = [
  { value: 'watching',      label: '在看',   color: '#0a84ff' },
  { value: 'completed',     label: '看完',   color: '#30d158' },
  { value: 'plan_to_watch', label: '想看',   color: '#5ac8fa' },
  { value: 'dropped',       label: '放弃',   color: '#ff453a' }
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
