# Future Features

Ideas for future development, not yet planned or scheduled.

## 1. User Avatar Upload
- Allow users to upload profile pictures (currently displays initials only)
- Image storage (S3/Cloudinary or similar)
- Crop/resize on upload
- Display in: profile page, activity feed, danmaku, watcher list

## 2. Anime Reviews & Ratings
- Long-form review system (separate from danmaku)
- Per-anime rating (1-10 scale)
- Review listing on anime detail page
- Helpful/unhelpful voting on reviews

## 3. Real-time Notifications
- Push notifications via Socket.IO for: new followers, danmaku replies, followed user activity
- Notification bell in navbar with unread count
- Notification history page
- Read/unread state management

## 6. User Achievements & Badges
- Track milestones: first review, first danmaku, N anime completed, etc.
- Badge display on user profile
- Achievement unlock notifications

## 7. AnimePGT - AI Agent Chat

AI-powered anime assistant with ChatGPT-like interface.

### Architecture
- SSE streaming for real-time AI responses
- Agent loop with function calling (LLM decides which tools to call)
- Provider abstraction layer (swap models via config)
- MongoDB `Conversation` model for chat history

### Agent Tools (reuse existing services)
- `searchAnime` - AniList search
- `getAnimeDetail` - detail with characters, relations, recommendations
- `getSeasonalAnime` - seasonal browse
- `getWeeklySchedule` - airing schedule
- `getTrending` - top anime
- `getUserWatchlist` - user's subscription list (read)
- `addToWatchlist` / `updateSubscription` - modify watchlist (write)

### Implementation Phases (revised per Codex review)
1. Streaming chat, single provider hardcoded (no abstraction), no tools
2. Add 2-4 read-only tools: `searchAnime`, `getAnimeDetail`, `getSeasonalAnime`, `getUserWatchlist`
3. Conversation persistence + sidebar UI
4. Safety + quotas (rate limiting, token tracking, content moderation)
5. Optional write tools with explicit user confirmation gate

### Model Candidates
| Provider | Model | Cost | Notes |
|----------|-------|------|-------|
| Zhipu (智谱) | GLM-4-Flash | Free forever | 128K context, supports tool use, 2 QPS |
| Zhipu (智谱) | GLM-Z1-Flash | Free forever | Reasoning model |
| DeepSeek | V3 | ~$0.28/M tokens | Highest quality, very cheap |
| Alibaba (百炼) | Qwen3 | Free 70M tokens | Best Chinese, aggregation platform |
| SiliconFlow (硅基流动) | Open-source models | Free tier | OpenAI-compatible, multi-model |
| Tencent | Hunyuan-Lite | Free forever | Lightweight |

**Decision pending: which model to use.**

### Context Management Strategy

Three-layer context sent to LLM on every request:

**Layer 1 — System Prompt (fixed, ~500 tokens)**
- Persona: anime expert assistant
- Rules: must use tools for recommendations, reply in Chinese
- Always included

**Layer 2 — Dynamic Context Injection (per-request, ~200-500 tokens)**
- User profile summary: watching count, completed count, top-scored titles
- Current season info (year + season)
- Inject summary only, NOT full watchlist — LLM calls tools when it needs detail
- Saves tokens vs full data dump

**Layer 3 — Conversation History (trimmed to budget)**
- Token budget: ~6000 tokens max for history
- Trim strategy: keep recent messages, drop oldest when over budget
- Tool call results: NOT stored in DB, only user + assistant final replies stored
- LLM will re-call tools if it needs fresh data in future turns

**Tool result trimming:**
- Cap search results to 5 items
- Strip long fields (description, staff) from tool responses
- Only return fields LLM needs for decision-making

### Key Files (planned)
```
server/models/Conversation.js
server/routes/chat.routes.js
server/controllers/chat.controller.js
server/services/ai.service.js        (provider abstraction)
server/services/context.service.js    (system prompt + context injection)
client/src/pages/ChatPage.jsx
client/src/components/chat/           (Sidebar, Window, Input, Message)
client/src/hooks/useChat.js
client/src/api/chat.api.js
```

### Codex Feasibility Review (GPT-5.4)

**Verdict:** Solo-feasible as a narrow AI chat feature. Not solo-feasible as the full agent platform in one build.

**Key risks identified:**
- AniList 700ms/req throttle (`anilist.service.js:11`) — agent calling 2-4 tools adds 1.5-2s latency on top of LLM thinking time. Mitigation: prefer AnimeCache (MongoDB) over live AniList queries.
- Provider abstraction is premature — each model's tool_call format/behavior differs. Hardcode one provider first, abstract after real experience.
- Write tools are dangerous — LLM may misidentify anime or hallucinate IDs. All write operations (addToWatchlist, updateSubscription) must go through a user confirmation gate (render confirmation card in UI, user clicks to execute via existing REST API, never let LLM write directly).
- Context management is underspecified — token trimming, retries, partial-stream failure handling are where the real time goes.
- `getTrending` does not exist as a clean service function yet (only as subscription aggregates).

**Scope cuts for v1:**
- No provider abstraction — hardcode single provider
- No write tools — read-only tools only
- No Socket.IO reuse — plain SSE for chat, keep sockets for danmaku
- Smaller history window than planned until real usage data exists

### Reference
- [dandanplay-vi analysis](https://github.com/wiidede/dandanplay-vi) - danmaku integration patterns (see memory)
