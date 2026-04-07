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
const { authenticateToken } = require('./middleware/auth.middleware');
const profileCtrl        = require('./controllers/profile.controller');
const setupSocket        = require('./socket');

const app    = express();
const server = http.createServer(app);

// Trust reverse proxy (Nginx / Cloudflare)
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use('/api', apiLimiter);

// Routes
app.use('/api/auth',          authRoutes);
app.use('/api/anime',         animeRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/comments',      commentRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/danmaku',       danmakuRoutes);
app.get('/api/feed',          authenticateToken, profileCtrl.getFeed);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

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

    // Pre-populate current season into MongoDB (non-blocking, runs in background)
    const { warmCurrentSeason } = require('./services/anilist.service');
    warmCurrentSeason().catch(err =>
      console.error('❌ Season cache warm failed:', err.message)
    );
  });
})();
