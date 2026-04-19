const AnimeCache = require('../models/AnimeCache');

// Social media / messaging crawlers that need OG tags
const CRAWLER_RE = /facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|TelegramBot|Discordbot|WhatsApp|Line|Applebot|redditbot|Embedly|Quora Link Preview|Iframely|Pinterest|vkShare/i;

function pickTitle(doc) {
  return doc.titleChinese || doc.titleNative || doc.titleRomaji || doc.titleEnglish || 'AnimeGo';
}

function stripHtml(html) {
  return html ? html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim() : '';
}

function truncate(str, len = 160) {
  return str && str.length > len ? str.slice(0, len) + '...' : (str || '');
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' ');
}

const SITE_NAME = 'AnimeGoClub';
const SITE_URL = 'https://animegoclub.com';
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-default.png`;

const ORG_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "AnimeGoClub",
  "alternateName": ["AnimeGo", "animegoclub"],
  "url": SITE_URL,
  "logo": `${SITE_URL}/favicon-192.png`,
};

const FAVICON_LINKS = `<link rel="icon" href="${SITE_URL}/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="48x48" href="${SITE_URL}/favicon.png">
<link rel="icon" type="image/png" sizes="192x192" href="${SITE_URL}/favicon-192.png">
<link rel="manifest" href="${SITE_URL}/site.webmanifest">`;

const OG_TYPE_MAP = { TV: 'video.tv_show', MOVIE: 'video.movie', OVA: 'video.tv_show', ONA: 'video.tv_show', SPECIAL: 'video.tv_show', MUSIC: 'video.other' };

function sendOgHtml(res, { title, desc, image, url, keywords, jsonLd, breadcrumbs, bodyHtml, ogType }) {
  const t = escapeHtml(title);
  const d = escapeHtml(desc);
  const i = escapeHtml(image || DEFAULT_OG_IMAGE);
  const u = escapeHtml(url);
  const k = keywords ? escapeHtml(keywords) : '';

  const defaultJsonLd = { "@context": "https://schema.org", "@type": "WebSite", "name": SITE_NAME, "url": SITE_URL, "description": desc };
  const ldBlocks = [jsonLd || defaultJsonLd];
  if (breadcrumbs) ldBlocks.push(breadcrumbs);

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>${t} - ${SITE_NAME}</title>
<meta name="description" content="${d}">
${k ? `<meta name="keywords" content="${k}">` : ''}
<link rel="canonical" href="${u}">
${FAVICON_LINKS}
<meta property="og:type" content="${ogType || 'website'}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${i}">
<meta property="og:url" content="${u}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${i}">
${ldBlocks.map(ld => `<script type="application/ld+json">\n${JSON.stringify(ld).replace(/</g, '\\u003c')}\n</script>`).join('\n')}
</head>
<body>${bodyHtml || `<h1>${t}</h1><p>${d}</p>`}</body>
</html>`);
}

function buildBreadcrumbs(items) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": items.map((item, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": item.name,
      "item": item.url,
    })),
  };
}

const FORMAT_MAP = { TV: 'TVSeries', MOVIE: 'Movie', OVA: 'TVSeries', ONA: 'TVSeries', SPECIAL: 'TVSeries', MUSIC: 'MusicVideoObject' };

// Google only supports aggregateRating (Review snippets) on these types
// https://developers.google.com/search/docs/appearance/structured-data/review-snippet#structured-data-type-definitions
const RATING_SUPPORTED_TYPES = new Set([
  'Book', 'Course', 'CreativeWorkSeason', 'CreativeWorkSeries', 'Episode',
  'Event', 'Game', 'HowTo', 'LocalBusiness', 'MediaObject', 'Movie',
  'MusicPlaylist', 'MusicRecording', 'Organization', 'Product', 'Recipe',
  'SoftwareApplication', 'TVSeries',
]);

// Chinese display labels for crawler HTML
const FORMAT_CN = { TV: 'TV动画', MOVIE: '剧场版', OVA: 'OVA', ONA: 'ONA', SPECIAL: '特别篇', MUSIC: '音乐' };
const STATUS_CN = { RELEASING: '连载中', FINISHED: '已完结', NOT_YET_RELEASED: '未开播', CANCELLED: '已取消', HIATUS: '暂停' };
const SEASON_CN = { WINTER: '冬', SPRING: '春', SUMMER: '夏', FALL: '秋' };
const SOURCE_CN = { MANGA: '漫画', LIGHT_NOVEL: '轻小说', VISUAL_NOVEL: '视觉小说', VIDEO_GAME: '游戏', ORIGINAL: '原创', NOVEL: '小说', OTHER: '其他' };
const RELATION_CN = { SEQUEL: '续集', PREQUEL: '前作', SIDE_STORY: '番外篇', PARENT: '本篇', ALTERNATIVE: '替代版', SPIN_OFF: '衍生', ADAPTATION: '改编', CHARACTER: '角色关联', SUMMARY: '总集篇', COMPILATION: '合集', CONTAINS: '包含', OTHER: '其他' };
const ROLE_CN = { MAIN: '主角', SUPPORTING: '配角', BACKGROUND: '群众' };

function buildAnimeJsonLd(doc, url) {
  const schemaType = FORMAT_MAP[doc.format] || 'CreativeWork';
  const title = pickTitle(doc);
  const ld = {
    "@context": "https://schema.org",
    "@type": schemaType,
    "name": title,
    "url": url,
    "image": doc.bannerImageUrl || doc.coverImageUrl || DEFAULT_OG_IMAGE,
    "description": truncate(stripHtml(doc.description), 300),
  };
  if (doc.genres?.length) ld.genre = doc.genres;
  const ratingCount = doc.bangumiVotes || doc.popularity;
  if (doc.averageScore && ratingCount && RATING_SUPPORTED_TYPES.has(schemaType)) {
    ld.aggregateRating = {
      "@type": "AggregateRating",
      "ratingValue": (doc.averageScore / 10).toFixed(1),
      "bestRating": "10",
      "worstRating": "1",
      "ratingCount": ratingCount,
    };
  }
  if (doc.episodes) ld.numberOfEpisodes = doc.episodes;
  if (doc.startDate?.year) {
    const m = String(doc.startDate.month || 1).padStart(2, '0');
    const d = String(doc.startDate.day || 1).padStart(2, '0');
    ld.datePublished = `${doc.startDate.year}-${m}-${d}`;
  }
  if (doc.titleNative && doc.titleNative !== title) ld.alternateName = doc.titleNative;
  return ld;
}

function buildAnimeBody(doc, base) {
  const title = pickTitle(doc);
  const h = escapeHtml;
  let html = `<h1>${h(title)}</h1>`;

  const desc = stripHtml(doc.description);
  if (desc) html += `<p>${h(truncate(desc, 500))}</p>`;

  // Info section
  html += '<h2>作品信息</h2><dl>';
  if (doc.format) html += `<dt>类型</dt><dd>${FORMAT_CN[doc.format] || doc.format}</dd>`;
  if (doc.episodes) html += `<dt>集数</dt><dd>${doc.episodes}集</dd>`;
  if (doc.status) html += `<dt>状态</dt><dd>${STATUS_CN[doc.status] || doc.status}</dd>`;
  if (doc.seasonYear && doc.season) html += `<dt>首播</dt><dd>${doc.seasonYear}年${SEASON_CN[doc.season] || doc.season}季</dd>`;
  if (doc.duration) html += `<dt>时长</dt><dd>${doc.duration}分钟/集</dd>`;
  if (doc.source) html += `<dt>原作</dt><dd>${SOURCE_CN[doc.source] || doc.source}</dd>`;
  if (doc.studios?.length) html += `<dt>制作</dt><dd>${doc.studios.map(s => h(s)).join('、')}</dd>`;
  const altTitles = [doc.titleNative, doc.titleRomaji, doc.titleEnglish].filter(t => t && t !== title);
  if (altTitles.length) html += `<dt>别名</dt><dd>${altTitles.map(t => h(t)).join(' / ')}</dd>`;
  html += '</dl>';

  // Genres
  if (doc.genres?.length) {
    html += `<h2>标签</h2><p>${doc.genres.map(g => h(g)).join('、')}</p>`;
  }

  // Scores
  const scores = [];
  if (doc.averageScore) scores.push(`AniList: ${(doc.averageScore / 10).toFixed(1)}/10`);
  if (doc.bangumiScore) scores.push(`Bangumi: ${doc.bangumiScore}/10${doc.bangumiVotes ? ` (${doc.bangumiVotes}票)` : ''}`);
  if (scores.length) html += `<h2>评分</h2><p>${scores.join(' | ')}</p>`;

  // Characters (top 12)
  if (doc.characters?.length) {
    const chars = doc.characters.slice(0, 12);
    html += '<h2>角色与声优</h2><ul>';
    for (const c of chars) {
      const name = h(c.nameCn || c.nameJa || c.nameEn || '');
      const va = c.voiceActorCn || c.voiceActorJa || c.voiceActorEn;
      const role = ROLE_CN[c.role] || c.role || '';
      html += `<li>${name}${va ? ` (CV: ${h(va)})` : ''}${role ? ` - ${role}` : ''}</li>`;
    }
    html += '</ul>';
  }

  // Staff (top 8)
  if (doc.staff?.length) {
    const staffList = doc.staff.slice(0, 8);
    html += '<h2>制作人员</h2><ul>';
    for (const s of staffList) {
      html += `<li>${h(s.nameJa || s.nameEn || '')} - ${h(s.role || '')}</li>`;
    }
    html += '</ul>';
  }

  // Relations with links
  if (doc.relations?.length) {
    html += '<h2>关联作品</h2><ul>';
    for (const r of doc.relations) {
      const relLabel = RELATION_CN[r.relationType] || r.relationType || '';
      html += `<li><a href="${base}/anime/${r.anilistId}">${relLabel}: ${h(r.title || '')}</a></li>`;
    }
    html += '</ul>';
  }

  // Recommendations with links (top 8)
  if (doc.recommendations?.length) {
    const recs = doc.recommendations.slice(0, 8);
    html += '<h2>相似推荐</h2><ul>';
    for (const r of recs) {
      const score = r.averageScore ? ` (${r.averageScore}分)` : '';
      html += `<li><a href="${base}/anime/${r.anilistId}">${h(r.title || '')}${score}</a></li>`;
    }
    html += '</ul>';
  }

  // Episode titles (top 50)
  if (doc.episodeTitles?.length) {
    const eps = doc.episodeTitles.slice(0, 50);
    html += '<h2>剧集列表</h2><ol>';
    for (const ep of eps) {
      const epTitle = ep.nameCn || ep.name || '';
      html += `<li>第${ep.episode}集${epTitle ? `: ${h(epTitle)}` : ''}</li>`;
    }
    html += '</ol>';
  }

  // Navigation
  html += `<nav><a href="${base}/">首页</a> | <a href="${base}/season">季度新番</a> | <a href="${base}/search">搜索动画</a></nav>`;

  return html;
}

/**
 * Middleware: intercept pages for social crawlers + search engine bots,
 * return rich HTML with SEO meta tags and substantive content.
 */
function ogTagsMiddleware(req, res, next) {
  const ua = req.get('user-agent') || '';
  // Also match major search engine bots for SEO
  if (!CRAWLER_RE.test(ua) && !/Googlebot|bingbot|Baiduspider|YandexBot|DuckDuckBot/i.test(ua)) return next();

  // Always use the canonical domain for URLs (not derived from request headers)
  const base = SITE_URL;

  // ── /anime/:id ──
  const animeMatch = req.path.match(/^\/anime\/(\d+)$/);
  if (animeMatch) {
    const anilistId = Number(animeMatch[1]);
    return AnimeCache.findOne({ anilistId }, {
      titleChinese: 1, titleNative: 1, titleRomaji: 1, titleEnglish: 1,
      coverImageUrl: 1, bannerImageUrl: 1, description: 1, genres: 1,
      averageScore: 1, popularity: 1, episodes: 1, format: 1,
      startDate: 1, bangumiVotes: 1, bangumiScore: 1,
      studios: 1, status: 1, season: 1, seasonYear: 1, duration: 1, source: 1,
      characters: 1, staff: 1, relations: 1, recommendations: 1, episodeTitles: 1,
    }).lean().then(doc => {
      if (!doc) {
        return sendOgHtml(res, {
          title: `动画 #${anilistId}`,
          desc: 'AnimeGoClub 番剧追番与动漫发现平台，提供每季新番、评分、角色声优、弹幕评论和追番管理。',
          url: `${base}/anime/${anilistId}`,
        });
      }
      const title = pickTitle(doc);
      const pageUrl = `${base}/anime/${anilistId}`;
      const rawDesc = truncate(stripHtml(doc.description), 200);
      const desc = rawDesc || [
        title,
        FORMAT_CN[doc.format],
        doc.seasonYear && doc.season ? `${doc.seasonYear}年${SEASON_CN[doc.season]}季` : null,
        doc.averageScore ? `评分 ${(doc.averageScore / 10).toFixed(1)}` : null,
        '动画 — AnimeGo',
      ].filter(Boolean).join(' · ');
      sendOgHtml(res, {
        title,
        desc,
        image: doc.bannerImageUrl || doc.coverImageUrl || '',
        url: pageUrl,
        keywords: doc.genres?.slice(0, 6).join(', '),
        jsonLd: buildAnimeJsonLd(doc, pageUrl),
        ogType: OG_TYPE_MAP[doc.format],
        breadcrumbs: buildBreadcrumbs([
          { name: '首页', url: base },
          { name: '动画', url: `${base}/season` },
          { name: title, url: pageUrl },
        ]),
        bodyHtml: buildAnimeBody(doc, base),
      });
    }).catch(() => {
      sendOgHtml(res, {
        title: `动画 #${anilistId}`,
        desc: 'AnimeGoClub 番剧追番与动漫发现平台，提供每季新番、评分、角色声优、弹幕评论和追番管理。',
        url: `${base}/anime/${anilistId}`,
      });
    });
  }

  // ── /season ──
  if (req.path === '/season' || req.path.startsWith('/season?')) {
    return sendOgHtml(res, {
      title: '季度新番',
      desc: '浏览每季度动画新番，按评分、格式和状态筛选，发现你的下一部追番。',
      image: DEFAULT_OG_IMAGE, url: `${base}/season`,
      breadcrumbs: buildBreadcrumbs([
        { name: '首页', url: base },
        { name: '季度新番', url: `${base}/season` },
      ]),
    });
  }

  // ── /search ──
  if (req.path === '/search') {
    return sendOgHtml(res, {
      title: '搜索动画',
      desc: '搜索数千部动画作品，查看评分、简介和详细信息。',
      image: DEFAULT_OG_IMAGE, url: `${base}/search`,
      breadcrumbs: buildBreadcrumbs([
        { name: '首页', url: base },
        { name: '搜索动画', url: `${base}/search` },
      ]),
    });
  }

  // ── / (homepage) ──
  if (req.path === '/') {
    return AnimeCache.find({ averageScore: { $gte: 70 } }, {
      anilistId: 1, titleChinese: 1, titleNative: 1, titleRomaji: 1,
      titleEnglish: 1, averageScore: 1, genres: 1,
    }).sort({ averageScore: -1 }).limit(30).lean().then(docs => {
      const siteDesc = 'AnimeGoClub (animegoclub.com) 是一个番剧追番与动漫发现平台，提供每季新番、作品评分、角色声优、弹幕评论和追番管理。';
      const t = escapeHtml('番剧追番 · 动漫发现 · 新番评分');
      const d = escapeHtml(siteDesc);
      const keywords = escapeHtml('AnimeGoClub,animegoclub,番剧,追番,新番,动漫,二次元,弹幕,动画评分');

      let animeLinks = '';
      if (docs && docs.length) {
        animeLinks = '<h2>AnimeGoClub 热门番剧</h2><ul>' + docs.map(a => {
          const name = escapeHtml(pickTitle(a));
          const score = a.averageScore ? ` (${a.averageScore}分)` : '';
          return `<li><a href="${base}/anime/${a.anilistId}">${name}${score}</a></li>`;
        }).join('') + '</ul>';
      }

      const allGenres = [...new Set(docs.flatMap(a => a.genres || []))].slice(0, 15);
      const genreText = allGenres.length ? `<p>热门类型：${allGenres.map(g => escapeHtml(g)).join('、')}</p>` : '';

      const websiteLd = {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "name": SITE_NAME,
        "alternateName": ["AnimeGo", "animegoclub"],
        "url": SITE_URL,
        "description": siteDesc,
        "potentialAction": {
          "@type": "SearchAction",
          "target": `${SITE_URL}/search?q={search_term_string}`,
          "query-input": "required name=search_term_string",
        },
      };

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>${SITE_NAME} · ${t}</title>
<meta name="description" content="${d}">
<meta name="keywords" content="${keywords}">
<link rel="canonical" href="${SITE_URL}/">
${FAVICON_LINKS}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${SITE_NAME} · ${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${DEFAULT_OG_IMAGE}">
<meta property="og:url" content="${SITE_URL}/">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${SITE_NAME} · ${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${DEFAULT_OG_IMAGE}">
<script type="application/ld+json">
${JSON.stringify(websiteLd).replace(/</g, '\\u003c')}
</script>
<script type="application/ld+json">
${JSON.stringify(ORG_JSON_LD).replace(/</g, '\\u003c')}
</script>
</head>
<body>
<h1>AnimeGoClub · 番剧追番与动漫发现平台</h1>
<p>${d}</p>
<p>AnimeGoClub 为番剧爱好者提供一站式追番体验：浏览每季新番、查看作品评分与角色声优信息、发送弹幕评论、管理个人追番列表。AnimeGoClub 汇集 AniList 与 Bangumi 数据，覆盖 TV 动画、剧场版、OVA、ONA 等多种番剧形式。</p>
<nav>
<a href="${base}/season">季度新番</a> |
<a href="${base}/search">搜索番剧</a>
</nav>
${animeLinks}
${genreText}
</body>
</html>`);
    }).catch(() => {
      sendOgHtml(res, {
        title: '番剧追番 · 动漫发现 · 新番评分',
        desc: 'AnimeGoClub (animegoclub.com) 是一个番剧追番与动漫发现平台，提供每季新番、作品评分、角色声优、弹幕评论和追番管理。',
        image: DEFAULT_OG_IMAGE, url: `${SITE_URL}/`,
      });
    });
  }

  next();
}

module.exports = ogTagsMiddleware;
