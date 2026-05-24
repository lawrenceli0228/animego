"use client";

// Small Client Component for the admin user table search input.
//
// Mirrors SearchFilters' debounced router.push pattern (see
// next-app/src/components/search/SearchFilters.tsx): the input feels
// real-time but only navigates after the user pauses typing. Resets
// pagination to page 1 on every q change so the result set stays
// consistent with the new filter (page 5 of a different query rarely
// means anything to the admin).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const DEBOUNCE_MS = 400;

interface UserSearchInputProps {
  initialQ: string;
}

function buildHref(q: string): string {
  const trimmed = q.trim();
  if (!trimmed) return "/admin/users";
  const params = new URLSearchParams();
  params.set("q", trimmed);
  return `/admin/users?${params.toString()}`;
}

export function UserSearchInput({ initialQ }: UserSearchInputProps) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const skipDebounceRef = useRef(true);
  // "Adjust state while rendering" pattern for syncing prop → local
  // state (back/forward navigation changes initialQ). React 19 bans
  // both setState-in-effect (react-hooks/set-state-in-effect) and
  // ref-mutation-during-render (react-hooks/refs), so the canonical
  // workaround uses useState for the diff sentinel itself: when the
  // setState call short-circuits the current render, React aborts and
  // restarts with the new state.
  // ref: react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [lastInitialQ, setLastInitialQ] = useState(initialQ);
  if (initialQ !== lastInitialQ) {
    setLastInitialQ(initialQ);
    setQ(initialQ);
  }

  useEffect(() => {
    if (skipDebounceRef.current) {
      skipDebounceRef.current = false;
      return;
    }
    if (q === initialQ) return;
    const timer = setTimeout(() => {
      router.push(buildHref(q));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, initialQ, router]);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    router.push(buildHref(q));
  };

  const onClear = () => {
    setQ("");
    router.push("/admin/users");
  };

  return (
    <form role="search" onSubmit={onSubmit} style={styles.form}>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索用户名或邮箱..."
        style={styles.input}
        aria-label="搜索用户"
      />
      {q && (
        <button type="button" onClick={onClear} style={styles.clearBtn}>
          清除
        </button>
      )}
    </form>
  );
}

const styles: Record<string, React.CSSProperties> = {
  form: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    marginBottom: 16,
  },
  input: {
    flex: "0 1 320px",
    minWidth: 200,
    padding: "9px 12px",
    borderRadius: 6,
    border: "1px solid #2a2a38",
    background: "#0d0d14",
    color: "#e7e7ef",
    fontSize: 13,
    outline: "none",
  },
  clearBtn: {
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid #2a2a38",
    background: "transparent",
    color: "#a8a8b8",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
};
