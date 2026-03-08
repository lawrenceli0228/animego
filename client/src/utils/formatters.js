export const formatScore = (score) => score ? `${score / 10}` : 'N/A';

export const formatEpisodes = (current, total) =>
  total ? `${current} / ${total} 集` : `第 ${current} 集`;

export const formatSeason = (season, year) =>
  season && year ? `${year} ${season}` : '未知季度';

export const stripHtml = (html) =>
  html ? html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim() : '';

export const truncate = (str, len = 150) =>
  str && str.length > len ? str.slice(0, len) + '...' : str;

/**
 * 根据语言选择最合适的番剧标题
 * zh 优先级: 中文名 → 日文原名 → 罗马音 → 英文名
 * en 优先级: 英文名 → 罗马音
 */
export function pickTitle(obj, lang) {
  if (lang === 'zh') {
    return obj.titleChinese || obj.titleNative || obj.titleRomaji || obj.titleEnglish || '';
  }
  return obj.titleEnglish || obj.titleRomaji || '';
}
