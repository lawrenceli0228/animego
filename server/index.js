require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');

const authRoutes         = require('./routes/auth.routes');
const animeRoutes        = require('./routes/anime.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const commentRoutes      = require('./routes/comment.routes');

const app = express();

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

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Error handler (must be last)
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// Connect DB → start server → warm current season cache in background
(async () => {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);

    // Pre-populate current season into MongoDB (non-blocking, runs in background)
    const { warmCurrentSeason } = require('./services/anilist.service');
    warmCurrentSeason().catch(err =>
      console.error('❌ Season cache warm failed:', err.message)
    );
  });
})();
