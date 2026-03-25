const en = {
  // Navbar
  nav: {
    home: 'Home', season: 'Season', search: 'Search',
    login: 'Login', register: 'Sign Up', logout: 'Logout',
    myList: 'My List', hi: 'Hi',
  },
  // Season labels
  season: {
    WINTER: 'Winter ❄️', SPRING: 'Spring 🌸', SUMMER: 'Summer ☀️', FALL: 'Fall 🍂',
    year: '',
  },
  // Homepage
  home: {
    scheduleLabel: 'SCHEDULE', thisWeek: 'This Week',
    continueLabel: 'Continue Watching', watchingTitle: 'Currently Watching',
    today: 'Today', noUpdates: 'No episodes today',
    trendingLabel: 'TRENDING', trendingTitle: 'Most Watched',
  },
  // Anime watchers
  anime: {
    watchers: 'watching', watchersMore: '+',
  },
  // Anime detail
  detail: {
    releasing: 'Releasing', finished: 'Finished',
    notYetReleased: 'Not Yet Released', cancelled: 'Cancelled',
    epUnit: 'Eps', readMore: 'Read more', collapse: 'Collapse',
    episodes: 'Episodes', noEpisodes: 'Episode info not available',
    ep: 'Ep', epOf: '/',
    viewDetails: 'View Details',
    viewOnBgm: 'View on Bangumi',
  },
  // Subscription
  sub: {
    addToList: '+ Add to List',
    watching: 'Watching', completed: 'Completed',
    planToWatch: 'Plan to Watch', dropped: 'Dropped',
    remove: 'Remove',
    loginToWatch: 'Login to Track',
    epUnit: 'Ep',
  },
  // Search
  search: {
    title: 'Search Anime',
    placeholder: 'Search anime title...',
    prompt: 'Enter a keyword or select a genre to search',
  },
  // Season page
  seasonPage: {
    title: 'Seasonal Anime',
  },
  // Login
  login: {
    title: 'AnimeGo', subtitle: 'Welcome back, continue your journey',
    email: 'Email', password: 'Password',
    submit: 'Login', submitting: 'Logging in...',
    noAccount: "Don't have an account? ", registerLink: 'Sign Up',
    forgotPassword: 'Forgot password?',
    success: 'Logged in!', fail: 'Login failed',
  },
  forgotPassword: {
    title: 'Reset Password', subtitle: "Enter your email and we'll send a reset link",
    email: 'Email', submit: 'Send Reset Link', submitting: 'Sending...',
    success: 'Reset link sent! Check your inbox (including spam folder)',
    backToLogin: 'Back to Login',
  },
  resetPassword: {
    title: 'Set New Password', subtitle: 'Enter your new password below',
    password: 'New Password (min. 6 chars)', confirm: 'Confirm New Password',
    submit: 'Reset Password', submitting: 'Resetting...',
    mismatch: 'Passwords do not match',
    success: 'Password reset! Please log in',
    invalidToken: 'Link is invalid or expired. Please request a new one.',
    backToLogin: 'Back to Login',
  },
  // Register
  register: {
    title: 'Create Account', subtitle: 'Join AnimeGo and start your watchlist',
    username: 'Username', email: 'Email', password: 'Password (min. 6 chars)',
    submit: 'Create Account', submitting: 'Creating...',
    hasAccount: 'Already have an account? ', loginLink: 'Login',
    success: 'Account created, welcome!', fail: 'Registration failed',
    pwdTooShort: 'Password must be at least 6 characters',
  },
  // Profile
  profile: {
    label: 'MY LIST', titleSuffix: "'s Watchlist",
    noAnime: 'No anime in',
    noAnimeSuffix: '',
  },
  // Torrent modal
  torrent: {
    title: 'Torrent Search', searchBtn: 'Search', btn: 'Magnet',
    copy: 'Copy', copied: 'Copied!',
    openMagnet: 'Open',
    size: 'Size', seeders: 'Seeds', date: 'Date',
    noResults: 'No results found',
    loading: 'Searching...', placeholder: 'Search query (romaji - episode)',
    groupAll: 'All',
  },
  // Social
  social: {
    follow: 'Follow', unfollow: 'Following',
    followers: 'Followers', following: 'Following',
    share: 'Share',
    feedLabel: 'ACTIVITY', feedTitle: "Friends' Updates",
    userNotFound: 'User not found',
    emptyList: 'No anime tracked yet',
    action_watching: 'is watching',
    action_completed: 'completed',
    action_plan_to_watch: 'wants to watch',
    action_dropped: 'dropped',
  },
  // Comments
  comment: {
    title: 'Comments', noComments: 'No comments yet. Be the first!',
    loginPrompt: '', loginLink: 'Login', loginSuffix: ' to post a comment',
    placeholder: 'Write a comment...', post: 'Post',
    posting: 'Posting...', delete: 'Delete',
    deleteConfirm: 'Delete this comment?',
    tooLong: 'Comment cannot exceed 500 characters',
  },
}

export default en
