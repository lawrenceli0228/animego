const AnimeCache = require('../models/AnimeCache');

const SITE = process.env.SITE_URL || 'https://animego.site';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
let cached = { xml: '', at: 0 };

async function sitemapMiddleware(req, res) {
  if (Date.now() - cached.at < CACHE_TTL) {
    res.set('Content-Type', 'application/xml');
    return res.send(cached.xml);
  }

  const docs = await AnimeCache.find({}, { anilistId: 1, cachedAt: 1 })
    .sort({ cachedAt: -1 })
    .limit(5000)
    .lean();

  const now = new Date().toISOString().split('T')[0];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
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
    <loc>${SITE}/search</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
`;

  for (const doc of docs) {
    const lastmod = doc.cachedAt ? new Date(doc.cachedAt).toISOString().split('T')[0] : now;
    xml += `  <url>
    <loc>${SITE}/anime/${doc.anilistId}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
    <lastmod>${lastmod}</lastmod>
  </url>
`;
  }

  xml += '</urlset>';

  cached = { xml, at: Date.now() };
  res.set('Content-Type', 'application/xml');
  res.send(xml);
}

module.exports = sitemapMiddleware;
