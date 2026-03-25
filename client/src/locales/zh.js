const zh = {
  // Navbar
  nav: {
    home: '首页', season: '季度', search: '搜索',
    login: '登录', register: '注册', logout: '登出',
    myList: '我的追番', hi: 'Hi',
  },
  // Season labels
  season: {
    WINTER: '冬季 ❄️', SPRING: '春季 🌸', SUMMER: '夏季 ☀️', FALL: '秋季 🍂',
    year: '年',
  },
  // Homepage
  home: {
    scheduleLabel: '放送日历', thisWeek: '本周更新',
    continueLabel: '继续追番', watchingTitle: '我的在追',
    today: '今天', noUpdates: '今日暂无更新',
    trendingLabel: '本季热追', trendingTitle: '大家都在追',
  },
  // Anime watchers
  anime: {
    watchers: '人在追', watchersMore: '还有',
  },
  // Anime detail
  detail: {
    releasing: '连载中', finished: '已完结',
    notYetReleased: '未开播', cancelled: '已取消',
    epUnit: '集', readMore: '展开更多', collapse: '收起',
    episodes: '集数列表', noEpisodes: '集数信息待更新',
    ep: '第', epOf: '/',
    viewDetails: '查看详情',
    viewOnBgm: '在 Bangumi 查看',
  },
  // Subscription
  sub: {
    addToList: '+ 添加到列表',
    watching: '在看', completed: '看完',
    planToWatch: '想看', dropped: '放弃',
    remove: '移除',
    loginToWatch: '登录后追番',
    epUnit: '集',
  },
  // Search
  search: {
    title: '搜索番剧',
    placeholder: '搜索番剧名称...',
    prompt: '输入关键词或选择类型开始搜索',
  },
  // Season page
  seasonPage: {
    title: '季度番剧',
  },
  // Login
  login: {
    title: 'AnimeGo', subtitle: '欢迎回来，继续追番之旅',
    email: '邮箱', password: '密码',
    submit: '登录', submitting: '登录中...',
    noAccount: '还没有账号？', registerLink: '立即注册',
    forgotPassword: '忘记密码？',
    success: '登录成功！', fail: '登录失败',
  },
  forgotPassword: {
    title: '重置密码', subtitle: '输入注册邮箱，我们将发送重置链接',
    email: '邮箱', submit: '发送重置链接', submitting: '发送中...',
    success: '重置链接已发送，请查收邮件（包括垃圾邮件）',
    backToLogin: '返回登录',
  },
  resetPassword: {
    title: '设置新密码', subtitle: '请输入你的新密码',
    password: '新密码（至少 6 位）', confirm: '确认新密码',
    submit: '确认重置', submitting: '重置中...',
    mismatch: '两次密码不一致',
    success: '密码已重置，请登录',
    invalidToken: '链接无效或已过期，请重新申请',
    backToLogin: '返回登录',
  },
  // Register
  register: {
    title: '创建账号', subtitle: '加入 AnimeGo，开始你的追番列表',
    username: '用户名', email: '邮箱', password: '密码（至少6位）',
    submit: '创建账号', submitting: '注册中...',
    hasAccount: '已有账号？', loginLink: '立即登录',
    success: '注册成功，欢迎加入！', fail: '注册失败',
    pwdTooShort: '密码至少 6 位',
  },
  // Profile
  profile: {
    label: '我的列表', titleSuffix: '的追番',
    noAnime: '还没有',
    noAnimeSuffix: '的番剧',
  },
  // Torrent modal
  torrent: {
    title: '磁力搜索', searchBtn: '搜索', btn: '磁链',
    copy: '复制', copied: '已复制',
    openMagnet: '打开',
    size: '大小', seeders: '做种', date: '日期',
    noResults: '暂无搜索结果',
    loading: '搜索中...', placeholder: '搜索词（罗马音 - 集数）',
    groupAll: '全部',
  },
  // Social
  social: {
    follow: '关注', unfollow: '已关注',
    followers: '粉丝', following: '关注',
    share: '分享',
    feedLabel: '动态流', feedTitle: '关注的人在追',
    userNotFound: '用户不存在',
    emptyList: '该用户还没有追番记录',
    action_watching: '正在看',
    action_completed: '看完了',
    action_plan_to_watch: '想看',
    action_dropped: '弃坑了',
  },
  // Danmaku
  danmaku: {
    label: '弹幕', live: 'LIVE', send: '发送',
    placeholder: '发条弹幕（最多50字）...',
    loginSuffix: '后发送弹幕',
    connected: '已连接', connecting: '连接中...',
    windowClosed: '首播窗口已关闭，仅可查看历史弹幕',
  },
  // Comments
  comment: {
    title: '集数评论', noComments: '暂无评论，来说点什么吧',
    loginPrompt: '请', loginLink: '登录', loginSuffix: '后参与评论',
    placeholder: '写下你的评论...', post: '发布',
    posting: '发布中...', delete: '删除',
    deleteConfirm: '确认删除？',
    tooLong: '评论不能超过500字',
  },
}

export default zh
