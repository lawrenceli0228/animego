const AnimeCache = require('../models/AnimeCache');

const SITE = process.env.SITE_URL || 'https://animegoclub.com';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
let cached = { xml: '', at: 0 };

function escapeXml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSeasonUrls(now) {
  // Cover the previous, current, and next 4 quarters so Googlebot has stable
  // entry points for major seasonal queries.
  const seasons = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  const currentYear = new Date().getFullYear();
  const out = [];
  for (let y = currentYear - 1; y <= currentYear + 1; y++) {
    for (const s of seasons) {
      out.push(`  <url>
    <loc>${SITE}/season?year=${y}&amp;season=${s}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
    <lastmod>${now}</lastmod>
  </url>
`);
    }
  }
  return out.join('');
}

async function sitemapMiddleware(req, res) {
  if (Date.now() - cached.at < CACHE_TTL && cached.xml) {
    res.set('Content-Type', 'application/xml');
    return res.send(cached.xml);
  }

  try {
  // Filter out pages that have no score and no description — those produce thin content.
  const docs = await AnimeCache.find(
    {
      $or: [
        { averageScore: { $gte: 30 } },
        { description: { $ne: null, $exists: true } },
      ],
    },
    {
      anilistId: 1, cachedAt: 1, averageScore: 1,
      coverImageUrl: 1, titleChinese: 1, titleRomaji: 1, titleEnglish: 1,
    }
  )
    .sort({ averageScore: -1, cachedAt: -1 })
    .limit(5000)
    .lean();

  const now = new Date().toISOString().split('T')[0];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${SITE}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE}/season</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE}/calendar</loc>
    <changefreq>daily</changefreq>
    <priority>0.85</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE}/about</loc>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE}/faq</loc>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE}/search</loc>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
    <lastmod>${now}</lastmod>
  </url>
${buildSeasonUrls(now)}`;

  for (const doc of docs) {
    const lastmod = doc.cachedAt ? new Date(doc.cachedAt).toISOString().split('T')[0] : now;
    // Higher-scored anime get higher priority (0.6-0.9)
    const score = doc.averageScore || 0;
    const priority = score >= 80 ? 0.9 : score >= 60 ? 0.8 : score >= 40 ? 0.7 : 0.6;
    const cover = doc.coverImageUrl;
    const title = doc.titleChinese || doc.titleRomaji || doc.titleEnglish || '';
    const imageBlock = cover
      ? `    <image:image>
      <image:loc>${escapeXml(cover)}</image:loc>
      <image:title>${escapeXml(title)}</image:title>
    </image:image>
`
      : '';
    xml += `  <url>
    <loc>${SITE}/anime/${doc.anilistId}</loc>
    <changefreq>weekly</changefreq>
    <priority>${priority}</priority>
    <lastmod>${lastmod}</lastmod>
${imageBlock}  </url>
`;
  }

  xml += '</urlset>';

  cached = { xml, at: Date.now() };
  res.set('Content-Type', 'application/xml');
  res.send(xml);
  } catch (err) {
    // Express 4 does not auto-catch async middleware rejections; return a minimal
    // valid sitemap so Googlebot doesn't see a 500 timeout.
    const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc></url>
</urlset>`;
    res.set('Content-Type', 'application/xml');
    res.status(200).send(fallback);
  }
}

module.exports = sitemapMiddleware;
