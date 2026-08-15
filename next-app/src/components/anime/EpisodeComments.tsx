"use client";

// Client port of legacy client/src/components/anime/EpisodeComments.jsx.
//
// Episode-scoped comment thread (parity gap: the SPA had this under the
// episode list; the next-app detail port dropped it). Backend is ready:
//   GET    /api/comments/:anilistId/:episode  (public)
//   POST   /api/comments/:anilistId/:episode  (auth)
//   DELETE /api/comments/:id                  (auth)
// go-api returns a FLAT list (camelCase, uuid `id`); we build the
// parentId tree client-side. Replies are flattened to 2 levels — a reply
// to a reply still attaches to the top-level parent (matches legacy).
//
// No react-query in next-app, so the data layer is hand-rolled: fetch on
// mount + on episode change, refetch after each mutation. Auth state is
// probed once via /api/auth/me (authFetch, silent on 401) so anonymous
// users get the login prompt instead of a bounce.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import toast from "react-hot-toast";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import { authFetch } from "@/lib/authFetch";
import { hasAuthHint } from "@/lib/clientAuth";
import { authChrome } from "@/lib/authChrome";
import { DEFAULT_CARD_IMAGE } from "@/lib/cardDefaults";
import FallbackImg from "@/components/ui/FallbackImg";
import { useLang } from "@/lib/lang-client";
import { deletedCommentCount } from "./episodeDiscussionState";
import ReportDialog from "@/components/safety/ReportDialog";

interface CommentDoc {
  id: string;
  anilistId: number;
  episode: number;
  userId: string;
  username: string;
  avatarUrl?: string | null;
  backdropCoverUrl?: string | null;
  content: string;
  isSpoiler?: boolean;
  parentId: string | null;
  replyToUsername: string | null;
  createdAt: string;
  reactionCount?: number;
  viewerReacted?: boolean;
}

type CommentNode = CommentDoc & { children: CommentNode[] };

interface CurrentUser {
  id: string;
  username: string;
}

interface ReplyTarget {
  id: string;
  username: string;
  parentId: string | null;
}

interface EpisodeCommentsProps {
  anilistId: number;
  episode: number;
  highlightCommentId?: string | null;
  onCommentDelta?: (episode: number, delta: number) => void;
}

const MAX_LEN = 500;

// ─── CommentInput ────────────────────────────────────────────────────
interface CommentInputProps {
  onSubmit: (text: string, isSpoiler: boolean, onDone: () => void) => void;
  isPending: boolean;
  placeholder: string;
  autoFocus?: boolean;
  onCancel?: () => void;
}

function CommentInput({
  onSubmit,
  isPending,
  placeholder,
  autoFocus,
  onCancel,
}: CommentInputProps) {
  const { t } = useLang();
  const [text, setText] = useState("");
  const [isSpoiler, setIsSpoiler] = useState(false);

  const handlePost = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed, isSpoiler, () => {
      setText("");
      setIsSpoiler(false);
    });
  };

  const disabled = isPending || !text.trim();

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handlePost();
        }}
        placeholder={placeholder}
        maxLength={MAX_LEN}
        rows={2}
        autoFocus={autoFocus}
        style={{
          width: "100%",
          padding: "10px 14px",
          borderRadius: 8,
          border: "1px solid #38383a",
          background: "#2c2c2e",
          color: "#ffffff",
          fontSize: 13,
          resize: "vertical",
          outline: "none",
          boxSizing: "border-box",
          fontFamily: "inherit",
          lineHeight: 1.6,
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 6,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: text.length > MAX_LEN - 20 ? "#ff453a" : "rgba(235,235,245,0.30)",
          }}
        >
          {text.length}/{MAX_LEN}
        </span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              color: "rgba(235,235,245,0.48)",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={isSpoiler}
              onChange={(event) => setIsSpoiler(event.target.checked)}
              style={{ accentColor: "#ff9f0a" }}
            />
            {t("comment.markSpoiler")}
          </label>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                background: "transparent",
                color: "rgba(235,235,245,0.40)",
                fontSize: 12,
              }}
            >
              {t("comment.cancel")}
            </button>
          )}
          <button
            type="button"
            onClick={handlePost}
            disabled={disabled}
            style={{
              padding: "6px 16px",
              borderRadius: 6,
              border: "none",
              cursor: disabled ? "default" : "pointer",
              background: "#0a84ff",
              color: "#fff",
              fontWeight: 500,
              fontSize: 12,
              opacity: disabled ? 0.35 : 1,
              transition: "opacity 0.2s",
            }}
          >
            {isPending ? t("comment.posting") : t("comment.post")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── CommentItem (recursive) ─────────────────────────────────────────
interface CommentItemProps {
  comment: CommentNode;
  user: CurrentUser | null;
  onReply: (c: CommentDoc) => void;
  onDelete: (id: string) => void;
  onReact: (comment: CommentDoc) => void;
  reactionBusyIds: ReadonlySet<string>;
  confirmId: string | null;
  setConfirmId: (id: string | null) => void;
  highlightedId?: string | null;
  depth?: number;
}

function CommentItem({
  comment: c,
  user,
  onReply,
  onDelete,
  onReact,
  reactionBusyIds,
  confirmId,
  setConfirmId,
  highlightedId,
  depth = 0,
}: CommentItemProps) {
  const { t } = useLang();
  const isOwn = !!user && user.id === c.userId;
  const highlighted = highlightedId === c.id;
  const reactionBusy = reactionBusyIds.has(c.id);
  const [spoilerRevealed, setSpoilerRevealed] = useState(false);

  return (
    <div
      id={`comment-${c.id}`}
      tabIndex={-1}
      style={{
        marginLeft: depth > 0 ? 24 : 0,
        padding: highlighted ? "8px 10px" : 0,
        marginRight: highlighted ? -10 : 0,
        borderRadius: 10,
        background: highlighted ? "rgba(10,132,255,0.12)" : "transparent",
        outline: "none",
        transition: "background 300ms",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          paddingTop: depth > 0 ? 10 : 0,
        }}
      >
        <Link
          href={`/u/${encodeURIComponent(c.username)}`}
          prefetch={false}
          aria-label={c.username}
          style={{
            width: depth > 0 ? 26 : 32,
            height: depth > 0 ? 26 : 32,
            borderRadius: "50%",
            background: "#0a84ff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            fontSize: depth > 0 ? 11 : 13,
            fontWeight: 700,
            color: "#fff",
            textTransform: "uppercase",
            overflow: "hidden",
            textDecoration: "none",
          }}
        >
          <FallbackImg
            src={c.avatarUrl ?? c.backdropCoverUrl ?? DEFAULT_CARD_IMAGE}
            fallback={DEFAULT_CARD_IMAGE}
            alt={c.username}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </Link>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 4,
              flexWrap: "wrap",
            }}
          >
            <Link
              href={`/u/${encodeURIComponent(c.username)}`}
              prefetch={false}
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#0a84ff",
                textDecoration: "none",
              }}
            >
              {c.username}
            </Link>
            {c.replyToUsername && (
              <span style={{ fontSize: 11, color: "rgba(235,235,245,0.30)" }}>
                → {c.replyToUsername}
              </span>
            )}
            <span style={{ fontSize: 11, color: "rgba(235,235,245,0.25)" }}>
              {new Date(c.createdAt).toLocaleDateString()}
            </span>
          </div>
          {c.isSpoiler && !spoilerRevealed ? (
            <button
              type="button"
              onClick={() => setSpoilerRevealed(true)}
              style={{
                width: "100%",
                border: "1px solid rgba(255,159,10,0.26)",
                borderRadius: 8,
                background: "rgba(255,159,10,0.08)",
                color: "#ffb340",
                padding: "9px 12px",
                textAlign: "left",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {t("comment.spoilerHidden")}
            </button>
          ) : (
            <p
              style={{
                fontSize: 13,
                color: "rgba(235,235,245,0.60)",
                lineHeight: 1.6,
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {c.content}
            </p>
          )}
          <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
            <button
              type="button"
              onClick={() => onReact(c)}
              disabled={reactionBusy}
              aria-pressed={Boolean(c.viewerReacted)}
              aria-label={t("comment.like")}
              style={{
                background: "none",
                border: "none",
                color: c.viewerReacted ? "#ff375f" : "rgba(235,235,245,0.30)",
                cursor: reactionBusy ? "default" : "pointer",
                fontSize: 11,
                padding: 0,
                opacity: reactionBusy ? 0.5 : 1,
              }}
            >
              {c.viewerReacted ? "♥" : "♡"} {c.reactionCount ?? 0}
            </button>
            {user && (
              <button
                type="button"
                onClick={() => onReply(c)}
                style={{
                  background: "none",
                  border: "none",
                  color: "rgba(235,235,245,0.30)",
                  cursor: "pointer",
                  fontSize: 11,
                  padding: 0,
                }}
              >
                {t("comment.reply")}
              </button>
            )}
            {!isOwn && (
              <ReportDialog
                targetType="comment"
                targetId={c.id}
                authenticated={Boolean(user)}
              />
            )}
            {isOwn &&
              (confirmId === c.id ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => {
                      onDelete(c.id);
                      setConfirmId(null);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#ff453a",
                      cursor: "pointer",
                      fontSize: 11,
                      padding: 0,
                      fontWeight: 600,
                    }}
                  >
                    {t("comment.deleteConfirm")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "rgba(235,235,245,0.30)",
                      cursor: "pointer",
                      fontSize: 11,
                      padding: 0,
                    }}
                  >
                    {t("comment.cancel")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmId(c.id)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "rgba(235,235,245,0.30)",
                    cursor: "pointer",
                    fontSize: 11,
                    padding: 0,
                  }}
                >
                  {t("comment.delete")}
                </button>
              ))}
          </div>
        </div>
      </div>
      {c.children.length > 0 && (
        <div
          style={{
            borderLeft: "2px solid #38383a",
            marginLeft: 15,
            marginTop: 4,
          }}
        >
          {c.children.map((r) => (
            <CommentItem
              key={r.id}
              comment={r}
              user={user}
              onReply={onReply}
              onDelete={onDelete}
              onReact={onReact}
              reactionBusyIds={reactionBusyIds}
              confirmId={confirmId}
              setConfirmId={setConfirmId}
              highlightedId={highlightedId}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── EpisodeComments ─────────────────────────────────────────────────
const sectionLabel: CSSProperties = {
  color: "#0a84ff",
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "2px",
  textTransform: "uppercase",
  marginBottom: 16,
};

export default function EpisodeComments({
  anilistId,
  episode,
  highlightCommentId,
  onCommentDelta,
}: EpisodeCommentsProps) {
  const { lang, t } = useLang();
  // Detail page path for the login link's ?from=. usePathname is safe on
  // this surface — /anime/* is prerendered (ISR) and Navbar already calls
  // it in the root layout there. useSearchParams would NOT be: it forces
  // a page-level Suspense boundary (Next 16 contract, see
  // app/player/page.tsx), and the detail page's query carries no comment
  // intent worth that.
  const pathname = usePathname();
  const [comments, setComments] = useState<CommentDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<CurrentUser | null>(null);
  // True while the auth_hint-gated /api/auth/me probe is in flight — the input
  // area shows a neutral placeholder (not the login prompt) during this window
  // so a logged-in user doesn't flash "登录后发表评论" before the box appears.
  const [probing, setProbing] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [posting, setPosting] = useState(false);
  const [reactionBusy, setReactionBusy] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // One-time auth probe, gated on the auth_hint cookie so an anonymous panel
  // open fires zero auth requests. While the probe is in flight `probing` is
  // true so the input area renders a neutral placeholder instead of the login
  // prompt; a logged-in user otherwise flashes "登录后发表评论" until
  // /api/auth/me resolves. Silent on 401 — anonymous users just see the prompt.
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      if (!hasAuthHint()) return;
      if (!cancelled) setProbing(true);
      try {
        const res = await authFetch("/api/auth/me", {
          skipRedirectOnFailure: true,
        });
        if (!cancelled && res.ok) {
          const json = (await res.json()) as { data?: { user?: CurrentUser } };
          if (!cancelled && json?.data?.user?.id) setUser(json.data.user);
        }
      } catch {
        /* anonymous — leave user null */
      } finally {
        if (!cancelled) setProbing(false);
      }
    };
    void resolve();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/comments/${anilistId}/${episode}`, {
        skipRedirectOnFailure: true,
      });
      if (!res.ok) {
        setComments([]);
        return;
      }
      const json = (await res.json()) as { data?: CommentDoc[] };
      const next = Array.isArray(json.data) ? json.data : [];
      setComments(next);
    } catch {
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [anilistId, episode]);

  // (Re)load comments on mount and whenever the selected episode changes.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Notification links land on a hash rather than a query param so this ISR
  // page stays free of useSearchParams/Suspense. Wait for the thread fetch,
  // then move both viewport and keyboard focus to the exact comment.
  useEffect(() => {
    if (loading || !highlightCommentId) return;
    const element = document.getElementById(`comment-${highlightCommentId}`);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.focus({ preventScroll: true });
  }, [loading, comments, highlightCommentId]);

  // Build the 2-level tree: roots (parentId=null, newest first) with
  // nested children keyed by parentId. A reply-to-a-reply still resolves
  // to the top-level parent because POST flattens parentId server-side.
  const tree = useMemo<CommentNode[]>(() => {
    const byParent = new Map<string, CommentDoc[]>();
    for (const c of comments) {
      const pid = c.parentId ?? "root";
      const bucket = byParent.get(pid);
      if (bucket) bucket.push(c);
      else byParent.set(pid, [c]);
    }
    const attach = (list: CommentDoc[]): CommentNode[] =>
      list.map((c) => ({ ...c, children: attach(byParent.get(c.id) ?? []) }));
    const roots = [...(byParent.get("root") ?? [])].reverse();
    return attach(roots);
  }, [comments]);

  const post = useCallback(
    async (
      body: { content: string; isSpoiler?: boolean; parentId?: string; replyToUsername?: string },
      onDone: () => void,
    ) => {
      setPosting(true);
      try {
        const res = await authFetch(`/api/comments/${anilistId}/${episode}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          onDone();
          onCommentDelta?.(episode, 1);
          await load();
        } else {
          toast.error(t("comment.postFailed"));
        }
      } catch {
        toast.error(t("comment.networkFailed"));
      } finally {
        setPosting(false);
      }
    },
    [anilistId, episode, load, onCommentDelta, t],
  );

  const handlePost = (text: string, isSpoiler: boolean, onDone: () => void) => {
    void post({ content: text, isSpoiler }, onDone);
  };

  const handleReply = (text: string, isSpoiler: boolean, onDone: () => void) => {
    if (!replyTarget) return;
    const topParentId = replyTarget.parentId || replyTarget.id;
    void post(
      { content: text, isSpoiler, parentId: topParentId, replyToUsername: replyTarget.username },
      () => {
        onDone();
        setReplyTarget(null);
      },
    );
  };

  const startReply = (c: CommentDoc) => {
    setReplyTarget({ id: c.id, username: c.username, parentId: c.parentId });
  };

  const handleDelete = useCallback(
    async (id: string) => {
      const removedCount = Math.max(1, deletedCommentCount(comments, id));
      try {
        const res = await authFetch(`/api/comments/${id}`, { method: "DELETE" });
        if (res.ok) {
          onCommentDelta?.(episode, -removedCount);
          await load();
        }
        else toast.error(t("comment.deleteFailed"));
      } catch {
        toast.error(t("comment.networkFailed"));
      }
    },
    [comments, episode, load, onCommentDelta, t],
  );

  const handleReaction = useCallback(
    async (comment: CommentDoc) => {
      if (!user) {
        window.location.assign(authHrefWithFrom("/login", pathname));
        return;
      }
      if (reactionBusy.has(comment.id)) return;
      const wasReacted = Boolean(comment.viewerReacted);
      const oldCount = comment.reactionCount ?? 0;
      const optimisticCount = Math.max(0, oldCount + (wasReacted ? -1 : 1));
      setReactionBusy((before) => new Set(before).add(comment.id));
      setComments((before) =>
        before.map((row) =>
          row.id === comment.id
            ? {
                ...row,
                viewerReacted: !wasReacted,
                reactionCount: optimisticCount,
              }
            : row,
        ),
      );
      try {
        const res = await authFetch(`/api/comments/${comment.id}/reaction`, {
          method: wasReacted ? "DELETE" : "PUT",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) throw new Error("reaction failed");
        const json = (await res.json().catch(() => null)) as {
          data?: {
            reactionCount?: number;
            viewerReacted?: boolean;
            count?: number;
            reacted?: boolean;
          };
        } | null;
        const serverCount = json?.data?.reactionCount ?? json?.data?.count;
        const serverReacted = json?.data?.viewerReacted ?? json?.data?.reacted;
        if (typeof serverCount === "number" || typeof serverReacted === "boolean") {
          setComments((before) =>
            before.map((row) =>
              row.id === comment.id
                ? {
                    ...row,
                    reactionCount:
                      typeof serverCount === "number" ? serverCount : optimisticCount,
                    viewerReacted:
                      typeof serverReacted === "boolean" ? serverReacted : !wasReacted,
                  }
                : row,
            ),
          );
        }
      } catch {
        setComments((before) =>
          before.map((row) =>
            row.id === comment.id
              ? { ...row, viewerReacted: wasReacted, reactionCount: oldCount }
              : row,
          ),
        );
        toast.error(t("comment.reactionFailed"));
      } finally {
        setReactionBusy((before) => {
          const next = new Set(before);
          next.delete(comment.id);
          return next;
        });
      }
    },
    [pathname, reactionBusy, t, user],
  );

  // "authed" → comment box · "probing" → neutral placeholder (never the login
  // prompt mid-probe) · "anonymous" → login prompt. See lib/authChrome.
  const chrome = authChrome(Boolean(user), probing);

  return (
    <div style={{ padding: "20px 24px 24px" }}>
      <p style={sectionLabel}>
        {t("comment.title")} · {t("detail.ep")} {episode}
        {comments.length > 0 && (
          <span
            style={{
              color: "rgba(235,235,245,0.30)",
              fontWeight: 400,
              marginLeft: 8,
            }}
          >
            · {comments.length} {lang === "zh" ? "条" : "comments"}
          </span>
        )}
      </p>

      {chrome === "probing" ? (
        // auth_hint says logged in but /api/auth/me hasn't resolved — neutral
        // placeholder, not the login prompt, so a logged-in user doesn't flash
        // "登录后发表评论" before the comment box appears.
        <div
          style={{
            marginBottom: 20,
            // ~matches the 2-row CommentInput footprint (textarea + button row)
            // so the placeholder → input swap doesn't shift the comment list.
            height: 88,
            borderRadius: 8,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid #2c2c2e",
          }}
          aria-hidden
        />
      ) : user ? (
        <div style={{ marginBottom: 20 }}>
          <CommentInput
            onSubmit={handlePost}
            isPending={posting && !replyTarget}
            placeholder={t("comment.placeholder")}
          />
        </div>
      ) : (
        <div
          style={{
            marginBottom: 20,
            padding: "12px 16px",
            borderRadius: 8,
            background: "rgba(10,132,255,0.08)",
            border: "1px solid rgba(10,132,255,0.15)",
            color: "rgba(235,235,245,0.60)",
            fontSize: 13,
          }}
        >
          {t("comment.loginPrompt")}
          {/* ?from= this detail page: the prompt exists because the user
              wants to say something about THIS episode, and a bare
              "/login" spent that intent on a trip to the home feed. */}
          <Link
            href={authHrefWithFrom("/login", pathname)}
            prefetch={false}
            style={{ color: "#0a84ff", fontWeight: 600, textDecoration: "none" }}
          >
            {t("comment.loginLink")}
          </Link>
          {t("comment.loginSuffix")}
        </div>
      )}

      {replyTarget && (
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            borderRadius: 10,
            background: "rgba(10,132,255,0.06)",
            border: "1px solid rgba(10,132,255,0.15)",
          }}
        >
          <p
            style={{
              fontSize: 12,
              color: "rgba(235,235,245,0.40)",
              margin: "0 0 8px",
            }}
          >
            {lang === "zh"
              ? `回复 @${replyTarget.username}`
              : `Replying to @${replyTarget.username}`}
          </p>
          <CommentInput
            onSubmit={handleReply}
            isPending={posting && !!replyTarget}
            placeholder={
              lang === "zh"
                ? `回复 ${replyTarget.username}...`
                : `Reply to ${replyTarget.username}...`
            }
            autoFocus
            onCancel={() => setReplyTarget(null)}
          />
        </div>
      )}

      {loading ? (
        <p
          style={{
            color: "rgba(235,235,245,0.30)",
            fontSize: 13,
            textAlign: "center",
            padding: "16px 0",
          }}
        >
          ...
        </p>
      ) : tree.length === 0 ? (
        <p
          style={{
            color: "rgba(235,235,245,0.30)",
            fontSize: 13,
            textAlign: "center",
            padding: "16px 0",
          }}
        >
          {t("comment.noComments")}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {tree.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              user={user}
              onReply={startReply}
              onDelete={handleDelete}
              onReact={handleReaction}
              reactionBusyIds={reactionBusy}
              confirmId={confirmId}
              setConfirmId={setConfirmId}
              highlightedId={highlightCommentId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
