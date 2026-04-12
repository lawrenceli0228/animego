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
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SITE_NAME = 'AnimeGo';
const SITE_URL = 'https://animegoclub.com';
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-default.png`;

const FAVICON_LINKS = `<link rel="icon" href="${SITE_URL}/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="48x48" href="${SITE_URL}/favicon.png">
<link rel="icon" type="image/png" sizes="192x192" href="${SITE_URL}/favicon-192.png">
<link rel="manifest" href="${SITE_URL}/site.webmanifest">`;

function sendOgHtml(res, { title, desc, image, url, keywords, jsonLd, breadcrumbs }) {
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
<meta property="og:type" content="website">
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
<body><h1>${t}</h1><p>${d}</p></body>
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
  if (doc.averageScore) {
    ld.aggregateRating = {
      "@type": "AggregateRating",
      "ratingValue": (doc.averageScore / 10).toFixed(1),
      "bestRating": "10",
      "worstRating": "1",
      "ratingCount": doc.bangumiVotes || doc.popularity || 100,
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

/**
 * Middleware: intercept pages for social crawlers + search engine bots,
 * return minimal HTML with SEO meta tags.
 */
function ogTagsMiddleware(req, res, next) {
  const ua = req.get('user-agent') || '';
  // Also match major search engine bots for SEO
  if (!CRAWLER_RE.test(ua) && !/Googlebot|bingbot|Baiduspider|YandexBot|DuckDuckBot/i.test(ua)) return next();

  const base = `${req.protocol}://${req.get('host')}`;

  // ── /anime/:id ──
  const animeMatch = req.path.match(/^\/anime\/(\d+)$/);
  if (animeMatch) {
    const anilistId = Number(animeMatch[1]);
    return AnimeCache.findOne({ anilistId }, {
      titleChinese: 1, titleNative: 1, titleRomaji: 1, titleEnglish: 1,
      coverImageUrl: 1, bannerImageUrl: 1, description: 1, genres: 1,
      averageScore: 1, popularity: 1, episodes: 1, format: 1,
      startDate: 1, popularity: 1, bangumiVotes: 1,
    }).lean().then(doc => {
      if (!doc) return next();
      const title = pickTitle(doc);
      const rawDesc = doc.description;
      const pageUrl = `${base}/anime/${anilistId}`;
      sendOgHtml(res, {
        title,
        desc: truncate(stripHtml(rawDesc), 200),
        image: doc.bannerImageUrl || doc.coverImageUrl || '',
        url: pageUrl,
        keywords: doc.genres?.slice(0, 6).join(', '),
        jsonLd: buildAnimeJsonLd(doc, pageUrl),
        breadcrumbs: buildBreadcrumbs([
          { name: '首页', url: base },
          { name: '动画', url: `${base}/season` },
          { name: title, url: pageUrl },
        ]),
      });
    }).catch(() => next());
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
      const siteDesc = 'AnimeGo 是一个动漫追番与发现平台，提供每季新番、评分、角色信息、弹幕评论和追番管理。';
      const t = escapeHtml('动漫 · 二次元 · 发现');
      const d = escapeHtml(siteDesc);

      let animeLinks = '';
      if (docs && docs.length) {
        animeLinks = '<h2>热门动画</h2><ul>' + docs.map(a => {
          const name = escapeHtml(pickTitle(a));
          const score = a.averageScore ? ` (${a.averageScore}分)` : '';
          return `<li><a href="${base}/anime/${a.anilistId}">${name}${score}</a></li>`;
        }).join('') + '</ul>';
      }

      const allGenres = [...new Set(docs.flatMap(a => a.genres || []))].slice(0, 15);
      const genreText = allGenres.length ? `<p>热门类型：${allGenres.map(g => escapeHtml(g)).join('、')}</p>` : '';

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>${SITE_NAME} - ${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${base}">
${FAVICON_LINKS}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${DEFAULT_OG_IMAGE}">
<meta property="og:url" content="${base}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${DEFAULT_OG_IMAGE}">
<script type="application/ld+json">
${JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", "name": "AnimeGo", "url": SITE_URL, "description": siteDesc, "potentialAction": { "@type": "SearchAction", "target": `${SITE_URL}/search?q={search_term_string}`, "query-input": "required name=search_term_string" } }).replace(/</g, '\\u003c')}
</script>
</head>
<body>
<h1>AnimeGo - 动漫 · 二次元 · 发现</h1>
<p>${d}</p>
<nav>
<a href="${base}/season">季度新番</a> |
<a href="${base}/search">搜索动画</a>
</nav>
${animeLinks}
${genreText}
</body>
</html>`);
    }).catch(() => {
      sendOgHtml(res, {
        title: '动漫 · 二次元 · 发现',
        desc: 'AnimeGo 是一个动漫追番与发现平台，提供每季新番、评分、角色信息、弹幕评论和追番管理。',
        image: DEFAULT_OG_IMAGE, url: base,
      });
    });
  }

  next();
}

module.exports = ogTagsMiddleware;
