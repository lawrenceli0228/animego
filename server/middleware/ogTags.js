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
// Dimensions for known image sources. AniList covers are 460×650 (portrait),
// AniList banners are ~1900×400 (landscape), default OG is 1200×630.
const DEFAULT_OG_IMAGE_DIMS = { width: 1200, height: 630 };
const ANILIST_COVER_DIMS = { width: 460, height: 650 };
const ANILIST_BANNER_DIMS = { width: 1900, height: 400 };

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

function sendOgHtml(res, { title, desc, image, url, keywords, jsonLd, breadcrumbs, bodyHtml, ogType, noindex, imageDims }) {
  const t = escapeHtml(title);
  const d = escapeHtml(desc);
  const finalImage = image || DEFAULT_OG_IMAGE;
  const i = escapeHtml(finalImage);
  const u = escapeHtml(url);
  const k = keywords ? escapeHtml(keywords) : '';

  // Caller may pass explicit imageDims when they know the image source. Otherwise
  // assume AniList portrait cover (most common when image is supplied) or default OG.
  const dims = imageDims || ((image && image !== DEFAULT_OG_IMAGE) ? ANILIST_COVER_DIMS : DEFAULT_OG_IMAGE_DIMS);

  const defaultJsonLd = { "@context": "https://schema.org", "@type": "WebSite", "name": SITE_NAME, "url": SITE_URL, "description": desc };
  const ldBlocks = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [defaultJsonLd];
  if (breadcrumbs) ldBlocks.push(breadcrumbs);

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>${t} — ${SITE_NAME}</title>
<meta name="description" content="${d}">
${k ? `<meta name="keywords" content="${k}">` : ''}
${noindex ? '<meta name="robots" content="noindex, follow">' : ''}
<link rel="canonical" href="${u}">
<link rel="alternate" hreflang="zh" href="${u}">
<link rel="alternate" hreflang="x-default" href="${u}">
${FAVICON_LINKS}
<meta property="og:type" content="${ogType || 'website'}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${i}">
<meta property="og:image:width" content="${dims.width}">
<meta property="og:image:height" content="${dims.height}">
<meta property="og:image:alt" content="${t}">
<meta property="og:url" content="${u}">
<meta property="og:locale" content="zh_CN">
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

// FAQ content kept in sync with client/src/locales/zh.js > landing.faq.
// When you edit one, edit both. The FAQPage JSON-LD here is what Google reads;
// the visible HTML on /about comes from the React FaqSection component.
const FAQ_ITEMS_ZH = [
  { q: 'AnimeGoClub 是免费的吗？', a: '是。没有会员、没有集数锁、没有"开通 VIP 解锁"。运营成本靠开源捐赠和自付，不放置任何广告。' },
  { q: 'AnimeGoClub 和 Bangumi、AniList、MAL 有什么区别？', a: 'AnimeGoClub 不是评分库，而是一个聚合层：合并 AniList 与 Bangumi 双平台数据并提供统一界面，重点解决中文用户在多平台之间切换的体验摩擦。我们也补强了弹幕评论与移动端浏览体验。' },
  { q: 'AnimeGoClub 是弹弹play 的替代品吗？', a: '不完全。弹弹play 专注于本地播放器与弹幕匹配 API，AnimeGoClub 则提供番剧发现、评分浏览与浏览器内追番管理，并通过 dandanplay API 复用其弹幕数据。两者更像互补关系。' },
  { q: '动画评分哪家更准？', a: '没有"最准"。AniList 的评分样本偏国际向、Bangumi 偏中文硬核、MAL 体量最大但样本偏老。AnimeGoClub 同时展示 AniList 与 Bangumi 评分，让你自己判断。' },
  { q: 'OVA / ONA / 剧场版 / 特别篇 有什么区别？', a: 'OVA 是 Original Video Animation，原本指录像带发行的非 TV 番外；ONA 是 Original Net Animation，网络首发；剧场版指院线发行；特别篇通常是 TV 番剧的衍生短篇。AnimeGoClub 在每部作品的详情页会标注其 format。' },
  { q: '弹幕从哪里来？支持哪些视频格式？', a: '弹幕来自站内评论 + 弹弹play API 聚合。播放器支持 MP4 / MKV 等主流格式，文件不会上传到服务器，所有处理在浏览器本地完成。' },
];

function buildFaqJsonLd(items) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": items.map(({ q, a }) => ({
      "@type": "Question",
      "name": q,
      "acceptedAnswer": { "@type": "Answer", "text": a },
    })),
  };
}

function buildFaqBodyHtml(items) {
  const h = escapeHtml;
  return items.map(({ q, a }) =>
    `<section><h2>${h(q)}</h2><p>${h(a)}</p></section>`
  ).join('');
}

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

  // Add character + voice actor as Person for long-tail "<声优>配音的动画" search.
  // Limit to top 8 main/supporting characters to keep payload reasonable.
  if (doc.characters?.length) {
    const persons = doc.characters
      .filter(c => (c.nameCn || c.nameJa || c.nameEn) && (c.role === 'MAIN' || c.role === 'SUPPORTING'))
      .slice(0, 8)
      .map(c => {
        const charName = c.nameCn || c.nameJa || c.nameEn;
        const va = c.voiceActorCn || c.voiceActorJa || c.voiceActorEn;
        const entry = { "@type": "PerformanceRole", "characterName": charName };
        if (va) entry.actor = { "@type": "Person", "name": va };
        return entry;
      });
    if (persons.length) ld.actor = persons;
  }

  // Add production company as Organization
  if (doc.studios?.length) {
    ld.productionCompany = doc.studios.slice(0, 3).map(s => ({ "@type": "Organization", "name": s }));
  }

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
      const ogImage = doc.bannerImageUrl || doc.coverImageUrl || '';
      const ogImageDims = doc.bannerImageUrl ? ANILIST_BANNER_DIMS : ANILIST_COVER_DIMS;
      return sendOgHtml(res, {
        title,
        desc,
        image: ogImage,
        imageDims: ogImage ? ogImageDims : DEFAULT_OG_IMAGE_DIMS,
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
      // Guard against double-response if sendOgHtml inside .then() threw after
      // headers were already sent.
      if (res.headersSent) return;
      sendOgHtml(res, {
        title: `动画 #${anilistId}`,
        desc: 'AnimeGoClub 番剧追番与动漫发现平台，提供每季新番、评分、角色声优、弹幕评论和追番管理。',
        url: `${base}/anime/${anilistId}`,
      });
    });
  }

  // ── /season (with optional ?year=&season= query) ──
  // Note: req.path never contains query string in Express — must read req.query.
  if (req.path === '/season') {
    const validSeasons = new Set(['WINTER', 'SPRING', 'SUMMER', 'FALL']);
    const yr = Number(req.query.year);
    const sn = String(req.query.season || '').toUpperCase();
    const hasParams = validSeasons.has(sn) && yr >= 1990 && yr <= 2100;

    if (hasParams) {
      const cn = SEASON_CN[sn];
      const url = `${base}/season?year=${yr}&season=${sn}`;
      return sendOgHtml(res, {
        title: `${yr}年${cn}季新番一览 · 评分与筛选`,
        desc: `${yr} 年${cn}季动画新番完整列表，含 TV、剧场版、OVA，按 AniList 与 Bangumi 评分排序，支持类型与状态筛选。在 AnimeGoClub 发现本季必追番剧。`,
        image: DEFAULT_OG_IMAGE,
        url,
        keywords: `${yr}${cn}季新番,${yr}年新番,新番推荐,本季新番,番剧排行`,
        bodyHtml: `<h1>${yr}年${cn}季新番一览</h1><p>${yr} 年${cn}季动画新番完整列表，按 AniList 与 Bangumi 双平台评分排序。</p><nav><a href="${base}/">首页</a> | <a href="${base}/season">所有季度</a></nav>`,
        breadcrumbs: buildBreadcrumbs([
          { name: '首页', url: base },
          { name: '季度新番', url: `${base}/season` },
          { name: `${yr}年${cn}季`, url },
        ]),
      });
    }

    return sendOgHtml(res, {
      title: '季度新番一览 · 每季评分排行',
      desc: 'AnimeGoClub 季度新番总览：选择年份和季节，查看 TV、剧场版、OVA 完整阵容，按 AniList 和 Bangumi 评分排序。',
      image: DEFAULT_OG_IMAGE, url: `${base}/season`,
      keywords: '季度新番,本季新番,新番推荐,番剧排行,新番评分',
      breadcrumbs: buildBreadcrumbs([
        { name: '首页', url: base },
        { name: '季度新番', url: `${base}/season` },
      ]),
    });
  }

  // ── /search (with optional ?q= query) ──
  if (req.path === '/search') {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q) {
      // qSafe is for raw HTML interpolation (bodyHtml). title/desc/url get
      // re-escaped by sendOgHtml — pass raw values there to avoid double-encoding.
      const qSafe = escapeHtml(q);
      const url = `${base}/search?q=${encodeURIComponent(q)}`;
      // Search-result pages get noindex to avoid indexing low-value query permutations.
      return sendOgHtml(res, {
        title: `搜索"${q}"的动画结果`,
        desc: `在 AnimeGoClub 搜索"${q}"的动画结果，查看评分、声优与简介。`,
        image: DEFAULT_OG_IMAGE,
        url,
        noindex: true,
        bodyHtml: `<h1>搜索"${qSafe}"的动画结果</h1><nav><a href="${base}/">返回首页</a></nav>`,
      });
    }
    return sendOgHtml(res, {
      title: '搜索动画 · 按名称或类型查找番剧',
      desc: '在 AnimeGoClub 搜索数千部动画，支持中文/日文/英文番名、按类型筛选（热血/恋爱/悬疑/异世界等），查看评分与详细信息。',
      image: DEFAULT_OG_IMAGE, url: `${base}/search`,
      keywords: '搜索动画,番剧搜索,动漫搜索,按类型查找,动画评分',
      breadcrumbs: buildBreadcrumbs([
        { name: '首页', url: base },
        { name: '搜索动画', url: `${base}/search` },
      ]),
    });
  }

  // ── /about (Landing page with AboutPage schema) ──
  // FAQ schema lives only on /faq to avoid Google picking the wrong URL as the
  // FAQ canonical; /about links to /faq instead of duplicating the Q&A list.
  if (req.path === '/about') {
    const url = `${base}/about`;
    const aboutLd = {
      "@context": "https://schema.org",
      "@type": "AboutPage",
      "name": `关于 ${SITE_NAME}`,
      "url": url,
      "description": 'AnimeGoClub 是一个番剧追番与动漫发现平台，聚合 AniList 与 Bangumi 数据，提供每季新番、评分、角色声优、弹幕评论和追番管理。',
    };
    return sendOgHtml(res, {
      title: '关于 AnimeGoClub · 番剧追番与动漫发现平台',
      desc: 'AnimeGoClub 聚合 AniList 与 Bangumi 双平台数据，覆盖 TV 动画、剧场版、OVA。免费、无广告、无会员，专注中文用户的追番体验。',
      image: DEFAULT_OG_IMAGE, url,
      keywords: 'AnimeGoClub,关于我们,番剧追番,动漫发现,弹幕评论',
      jsonLd: aboutLd,
      bodyHtml: `<h1>关于 AnimeGoClub</h1><p>AnimeGoClub (animegoclub.com) 是一个番剧追番与动漫发现平台。我们聚合 AniList 与 Bangumi 双平台数据，专为中文用户优化界面与浏览体验。</p><nav><a href="${base}/">首页</a> | <a href="${base}/season">季度新番</a> | <a href="${base}/faq">常见问题</a></nav>`,
      breadcrumbs: buildBreadcrumbs([
        { name: '首页', url: base },
        { name: '关于我们', url },
      ]),
    });
  }

  // ── /faq (dedicated FAQ page) ──
  if (req.path === '/faq') {
    const url = `${base}/faq`;
    return sendOgHtml(res, {
      title: 'AnimeGoClub 常见问题 FAQ',
      desc: '关于 AnimeGoClub 的常见疑问：是否免费、与 Bangumi/AniList/MAL 的区别、弹幕来源、OVA/ONA/剧场版的差异、支持的视频格式等。',
      image: DEFAULT_OG_IMAGE, url,
      keywords: 'AnimeGoClub FAQ,常见问题,弹弹play 替代,Bangumi 区别,OVA 是什么',
      jsonLd: buildFaqJsonLd(FAQ_ITEMS_ZH),
      bodyHtml: `<h1>AnimeGoClub 常见问题</h1>${buildFaqBodyHtml(FAQ_ITEMS_ZH)}<nav><a href="${base}/">首页</a> | <a href="${base}/about">关于我们</a></nav>`,
      breadcrumbs: buildBreadcrumbs([
        { name: '首页', url: base },
        { name: '常见问题', url },
      ]),
    });
  }

  // ── /calendar (放送日历) ──
  if (req.path === '/calendar') {
    const url = `${base}/calendar`;
    return sendOgHtml(res, {
      title: '今日新番放送日历 · 本周追番表',
      desc: '查看今日和本周新番放送日历，AniList 数据按周一到周日分组，不错过任何一集。AnimeGoClub 中文番剧追番平台。',
      image: DEFAULT_OG_IMAGE, url,
      keywords: '今日新番,本周新番,放送日历,新番更新表,番剧追番',
      bodyHtml: `<h1>今日新番放送日历</h1><p>查看本周新番放送时间表，按周一至周日分组排列，含连载中的 TV 动画与 ONA。</p><nav><a href="${base}/">首页</a> | <a href="${base}/season">季度新番</a></nav>`,
      breadcrumbs: buildBreadcrumbs([
        { name: '首页', url: base },
        { name: '放送日历', url },
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
<link rel="alternate" hreflang="zh" href="${SITE_URL}/">
<link rel="alternate" hreflang="x-default" href="${SITE_URL}/">
${FAVICON_LINKS}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${SITE_NAME} · ${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${DEFAULT_OG_IMAGE}">
<meta property="og:image:width" content="${DEFAULT_OG_IMAGE_DIMS.width}">
<meta property="og:image:height" content="${DEFAULT_OG_IMAGE_DIMS.height}">
<meta property="og:image:alt" content="${SITE_NAME}">
<meta property="og:url" content="${SITE_URL}/">
<meta property="og:locale" content="zh_CN">
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
