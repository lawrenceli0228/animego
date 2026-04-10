require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');

const authRoutes         = require('./routes/auth.routes');
const animeRoutes        = require('./routes/anime.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const commentRoutes      = require('./routes/comment.routes');
const userRoutes         = require('./routes/user.routes');
const danmakuRoutes      = require('./routes/danmaku.routes');
const adminRoutes        = require('./routes/admin.routes');
const { authenticateToken } = require('./middleware/auth.middleware');
const profileCtrl        = require('./controllers/profile.controller');
const ogTagsMiddleware   = require('./middleware/ogTags');
const sitemapMiddleware  = require('./middleware/sitemap');
const setupSocket        = require('./socket');

const app    = express();
const server = http.createServer(app);

// Trust Railway/Vercel reverse proxy
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Block requests from unauthorized host domains (anti-mirror/scraping)
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'animegoclub.com,localhost').split(',');
app.use((req, res, next) => {
  const host = (req.get('host') || '').replace(/:\d+$/, '');
  if (ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h))) return next();
  res.status(403).send('Forbidden');
});

app.use('/api', apiLimiter);

// Routes
app.use('/api/auth',          authRoutes);
app.use('/api/anime',         animeRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/comments',      commentRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/danmaku',       danmakuRoutes);
app.use('/api/admin',         adminRoutes);
app.get('/api/feed',          authenticateToken, profileCtrl.getFeed);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Google Search Console verification
app.get('/googlec1c1aceafd3279a2.html', (req, res) => {
  res.type('text/html').send('google-site-verification: googlec1c1aceafd3279a2.html');
});

// SEO: robots.txt, sitemap, OG tags (must be before static/SPA catch-all)
app.get('/robots.txt', (req, res) => {
  const site = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(`User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/

Host: https://animegoclub.com
Sitemap: ${site}/sitemap.xml
`);
});
app.get('/sitemap.xml', sitemapMiddleware);
app.use(ogTagsMiddleware);

// Serve React app in production
const clientDist = path.join(__dirname, '../client/dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  }
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Error handler (must be last)
app.use(errorHandler);

const PORT = process.env.PORT || 5001;

// Connect DB → start server → warm current season cache in background
(async () => {
  await connectDB();

  setupSocket(server);

  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);

    // Pre-populate current season + schedule 24h re-warm
    const { warmCurrentSeason } = require('./services/anilist.service');
    warmCurrentSeason()
      .catch(err => console.error('❌ Season warm failed:', err.message));
  });
})();
