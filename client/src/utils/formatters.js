export const formatScore = (score) => score ? `${score / 10}` : 'N/A';

export const formatEpisodes = (current, total) =>
  total ? `${current} / ${total} 集` : `第 ${current} 集`;

export const formatSeason = (season, year) =>
  season && year ? `${year} ${season}` : '未知季度';

export const stripHtml = (html) =>
  html ? html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim() : '';

export const truncate = (str, len = 150) =>
  str && str.length > len ? str.slice(0, len) + '...' : str;
