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
const DEFAULT_OG_IMAGE = 'https://animegoclub.com/og-default.png';

function sendOgHtml(res, { title, desc, image, url, keywords }) {
  const t = escapeHtml(title);
  const d = escapeHtml(desc);
  const i = escapeHtml(image || DEFAULT_OG_IMAGE);
  const u = escapeHtml(url);
  const k = keywords ? escapeHtml(keywords) : '';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>${SITE_NAME} - ${t}</title>
<meta name="description" content="${d}">
${k ? `<meta name="keywords" content="${k}">` : ''}
<link rel="canonical" href="${u}">
<link rel="icon" href="https://animegoclub.com/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="48x48" href="https://animegoclub.com/favicon.png">
<link rel="icon" type="image/png" sizes="192x192" href="https://animegoclub.com/favicon-192.png">
<link rel="manifest" href="https://animegoclub.com/site.webmanifest">
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
<script type="application/ld+json">
${JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", "name": "AnimeGo", "url": "https://animegoclub.com", "description": desc })}
</script>
</head>
<body><h1>${t}</h1><p>${d}</p></body>
</html>`);
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
    }).lean().then(doc => {
      if (!doc) return next();
      sendOgHtml(res, {
        title: pickTitle(doc),
        desc: truncate(stripHtml(doc.description), 200),
        image: doc.bannerImageUrl || doc.coverImageUrl || '',
        url: `${base}/anime/${anilistId}`,
        keywords: doc.genres?.slice(0, 4).join(' / '),
      });
    }).catch(() => next());
  }

  // ── /season ──
  if (req.path === '/season' || req.path.startsWith('/season?')) {
    return sendOgHtml(res, {
      title: '季度新番',
      desc: '浏览每季度动画新番，按评分、格式和状态筛选，发现你的下一部追番。',
      image: DEFAULT_OG_IMAGE, url: `${base}/season`,
    });
  }

  // ── /search ──
  if (req.path === '/search') {
    return sendOgHtml(res, {
      title: '搜索动画',
      desc: '搜索数千部动画作品，查看评分、简介和详细信息。',
      image: DEFAULT_OG_IMAGE, url: `${base}/search`,
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
<link rel="icon" href="https://animegoclub.com/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="48x48" href="https://animegoclub.com/favicon.png">
<link rel="icon" type="image/png" sizes="192x192" href="https://animegoclub.com/favicon-192.png">
<link rel="manifest" href="https://animegoclub.com/site.webmanifest">
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
${JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", "name": "AnimeGo", "url": "https://animegoclub.com", "description": siteDesc, "potentialAction": { "@type": "SearchAction", "target": "https://animegoclub.com/search?q={search_term_string}", "query-input": "required name=search_term_string" } })}
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
