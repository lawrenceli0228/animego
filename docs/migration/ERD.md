# AnimeGo Postgres Schema — Entity-Relationship Diagram

**Generated:** 2026-05-21 (end of P1)
**Source of truth:** `go-api/migrations/0001_init.up.sql` + `0002_indexes.up.sql` + `0003_defer_comment_self_fk.up.sql` + `0004_relax_bangumi_version.up.sql` + `0005_pg_cron_extension.up.sql` + `0006_danmaku_ttl_schedule.up.sql`

14 tables, 2 logical roots (`users`, `anime_cache`), every FK with `ON DELETE CASCADE` (per plan 二轮 review 1C decision).

---

## Top-down ASCII view

```
                      ┌──────────────────────────────────────┐
                      │ users                                │
                      │ ──────────────────────────────────── │
                      │ id                  uuid  PK         │
                      │ username            text  UNIQUE     │
                      │ email               text  UNIQUE     │
                      │ password            text  (bcrypt)   │
                      │ role                text  'admin'/∅  │
                      │ is_public           bool  DEFAULT t  │
                      │ refresh_token       text  nullable   │
                      │ reset_password_*    text  nullable   │
                      │ created_at, updated_at  timestamptz  │
                      └────────────┬─────────────────────────┘
                                   │
       ┌───────────────────────────┼───────────────────────────┬─────────────────────┐
       │ ON DELETE CASCADE         │                           │                     │
       ▼                           ▼                           ▼                     ▼
 ┌───────────────┐           ┌──────────────┐           ┌────────────────┐   ┌─────────────┐
 │ follows       │           │subscriptions │           │episode_comments│   │  danmakus   │
 │ ────────────  │           │ ──────────── │           │ ────────────── │   │ ─────────── │
 │ follower_id   │ ──┐       │ user_id   ───┼──┐        │ id      uuid PK│   │ id   bigint │
 │ followee_id   │ ──┤       │ anilist_id ──┼──┼──┐     │ user_id    ────┼─┐ │      IDENTY │
 │ PK(both)      │   │       │ PK(both)     │  │  │     │ anilist_id ────┼─┼─┤ user_id ────┼─┐
 │ created/upd   │   │       │ status ENUM  │  │  │     │ episode int    │ │ │ anilist_id ─┼─┤
 └───────────────┘   │       │ current_ep   │  │  │     │ content ≤500   │ │ │ episode int │ │
                     │       │ score 1-10|∅ │  │  │     │ parent_id self │◀┘ │ content ≤50 │ │
                     │       │ last_wat_at  │  │  │     │   FK DEFERRED  │   │ live_ends_at│ │
                     │       └──────────────┘  │  │     │ reply_to_user  │   │ created_at  │ │
                     │                         │  │     │ created/upd    │   │ pg_cron 1y  │ │
                     │                         │  │     └────────────────┘   │  TTL DELETE │ │
                     │                         │  │                          └─────────────┘ │
                     │                         │  │                                          │
                     │      (1 FK to users for both legs of follow, both CASCADE)            │
                     │                         │  │                                          │
       ──────────────┘                         │  │                ┌─────────────────────────┘
                                               │  │                │
                              ┌────────────────┼──┼────────────────┼─────────────────────┐
                              │                ▼  ▼                ▼                     ▼
                              │       ┌──────────────────────────────────┐       ┌──────────────────┐
                              └──────▶│ anime_cache                      │◀──────│ episode_windows  │
                                      │ ──────────────────────────────── │       │ ──────────────── │
                                      │ anilist_id    integer  PK        │       │ anilist_id    PK │
                                      │ title_romaji/english/native/cn   │       │ episode       PK │
                                      │ cover_image_url, color, accent…  │       │ live_ends_at     │
                                      │ description                      │       │ (no timestamps)  │
                                      │ episodes, status, season, year   │       └──────────────────┘
                                      │ average_score   numeric(4,2)     │
                                      │ bangumi_id/score/votes/version   │
                                      │ start_date  date  (make_date)    │
                                      │ admin_flag  needs-review|manual-… │
                                      │ search_vec  tsvector GENERATED   │
                                      │ created_at / updated_at / cached │
                                      └────────────┬─────────────────────┘
                                                   │ ON DELETE CASCADE
                                                   │
          ┌───────────┬─────────────┬─────────────┬┼───────────┬───────────┬───────────────┐
          ▼           ▼             ▼             ▼            ▼           ▼               ▼
   ┌──────────┐ ┌───────────┐ ┌─────────────┐ ┌─────────┐ ┌─────────┐ ┌──────────────────┐ ┌─────────────────────┐
   │anime_    │ │anime_     │ │anime_       │ │anime_   │ │anime_   │ │anime_            │ │anime_episode_titles │
   │genres    │ │studios    │ │relations    │ │chars    │ │staff    │ │recommendations   │ │ ─────────────────── │
   │ ─────── │ │ ─────────│ │ ─────────── │ │─────────│ │─────────│ │ ────────────── │ │ anime_id     PK     │
   │anime_id  │ │anime_id   │ │id      uuid │ │id uuid  │ │id uuid  │ │id          uuid  │ │ episode      PK     │
   │ FK PK    │ │ FK PK     │ │anime_id FK  │ │anime_id │ │anime_id │ │anime_id    FK    │ │ name_cn / name      │
   │genre     │ │studio     │ │anilist_id   │ │display_ │ │display_ │ │anilist_id  rec'd │ │  (LAST-wins dedup)  │
   │ (PK pair)│ │ (PK pair) │ │relation_type│ │order    │ │order    │ │title             │ └─────────────────────┘
   │          │ │           │ │title        │ │name_*   │ │name_*   │ │cover_image_*     │
   │          │ │           │ │cover_image_*│ │image_url│ │image_url│ │poster_accent_*   │
   │          │ │           │ │poster_accen.│ │role     │ │role     │ │average_score     │
   │          │ │           │ │format       │ │voice_*  │ │         │ │                  │
   └──────────┘ └───────────┘ └─────────────┘ └─────────┘ └─────────┘ └──────────────────┘
```

---

## Cardinality summary

| Relationship | Notation |
|---|---|
| users → subscriptions | 1 — N(每 user 多个订阅) |
| users → follows | 1 — N(双向,每 user 是 follower 或 followee 各 N) |
| users → episode_comments | 1 — N |
| users → danmakus | 1 — N |
| anime_cache → anime_genres | 1 — N(展开 Mongo `genres: []string`) |
| anime_cache → anime_studios | 1 — N |
| anime_cache → anime_relations | 1 — N |
| anime_cache → anime_characters | 1 — N(display_order 保留 array index) |
| anime_cache → anime_staff | 1 — N |
| anime_cache → anime_recommendations | 1 — N |
| anime_cache → anime_episode_titles | 1 — N(同 anime + episode 唯一,prod 17 个 anime dedup last-wins) |
| anime_cache → subscriptions / danmakus / comments / episode_windows | 1 — N |
| episode_comments → episode_comments | 1 — N(self-FK,DEFERRABLE INITIALLY DEFERRED) |

---

## 索引概览(0002 + auto from PK/UNIQUE)

```
anime_cache:
  PK              btree (anilist_id)
  search_vec      GIN  (tsvector GENERATED ALWAYS)
  title_cn_trgm   GIN  (title_chinese gin_trgm_ops)    ← dandanplay AnimeCache regex 替代
  title_native_trgm  GIN
  title_romaji_trgm  GIN
  title_english_trgm GIN
  season_idx      btree (season, season_year)
  admin_flag_idx  btree (admin_flag) WHERE admin_flag IS NOT NULL  ← partial

users:                  UNIQUE on username, email
subscriptions:          PK(user_id, anilist_id) + idx(user_id,status) + idx(anilist_id)
follows:                PK(follower_id, followee_id) + idx(followee_id)
episode_comments:       PK(id) + idx(anilist_id, episode) + idx(parent_id) partial + idx(user_id)
danmakus:               PK(id bigint) + idx(anilist_id, episode, created_at) + idx(created_at) ← pg_cron TTL scan
episode_windows:        PK(anilist_id, episode)
anime_* children:       PK as listed; child tables w/ surrogate UUID get idx(anime_id)
```

---

## Extensions

| Extension | Where | Why |
|---|---|---|
| `pgcrypto` | 0001 | `gen_random_uuid()` for users.id / comments.id / anime_* children.id |
| `pg_trgm` | 0001 | `gin_trgm_ops` 四个 title 列(dandanplay AnimeCache regex 替代) |
| `pg_cron` | 0005 | `cron.schedule('danmaku-ttl', '0 4 * * *', DELETE WHERE created_at < now() - INTERVAL '1 year')` |

---

## ObjectId → UUID 映射

所有 Mongo `ObjectId` 字段(users._id、comments._id、relations 的 referenced animes 等)统一通过 `internal/migrate/transforms/util.go` 里的 `MongoIDToUUID(id any) (uuid.UUID, error)` 函数转换:

```
uuid_v5 = SHA1(AnimegoNamespace || ObjectId 12-byte payload)
       Namespace = ab8f6f3a-4c0d-5b3f-9c4d-7e8f1c2b3d4e (frozen forever)
```

性质:
- **Deterministic** — 同 ObjectId 永远映射到同 UUID,re-run migration 不破坏外键
- **Cross-collection consistent** — `subscriptions.user_id` 跟 `users.id` 用同一映射,所以 FK 自然关联
- **No lookup table** — 不需要在 migration 时维护 ObjectId → UUID 的 in-memory map,内存稳

⚠️ AnimegoNamespace 一旦改,所有 user_id / comment_id / 等等全 UUID 都变,FK 关系全断。**永远不能改**。
