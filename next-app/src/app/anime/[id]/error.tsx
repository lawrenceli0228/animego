"use client";

// Route-level error boundary for /anime/[id]. Replaces the bare
// "Internal Server Error" the user used to see when loadDetail() threw on
// a transient upstream failure (e.g. go-api returning 502 "AniList
// upstream error" while AniList rate-limits us during an SEO crawl, or a
// 429 from go-api's own inbound limiter).
//
// Unlike global-error.tsx (which replaces the whole document on a root
// crash), this boundary only swaps the page segment — the Navbar and
// layout chrome stay — so the user gets a coherent, retryable surface
// instead of a blank 500. `reset()` re-runs the failed server render,
// which usually succeeds on the second try once the upstream blip passes.

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";

interface DetailErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

const card = {
  maxWidth: 460,
  margin: "0 auto",
  padding: "56px 24px 80px",
  textAlign: "center" as const,
};

const primaryBtn = {
  padding: "10px 22px",
  borderRadius: 10,
  border: "none",
  background: "#0a84ff",
  color: "#fff",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};

const secondaryBtn = {
  padding: "10px 22px",
  borderRadius: 10,
  border: "1px solid rgba(84,84,88,0.65)",
  background: "transparent",
  color: "rgba(235,235,245,0.75)",
  fontSize: 14,
  fontWeight: 600,
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
};

export default function DetailError({ error, reset }: DetailErrorProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="container" style={card}>
      <div style={{ fontSize: 40, marginBottom: 16 }} aria-hidden="true">
        🌥️
      </div>
      <h1
        style={{
          fontFamily: "'Sora', sans-serif",
          fontSize: 22,
          color: "#ffffff",
          marginBottom: 10,
          lineHeight: 1.3,
        }}
      >
        这一页暂时加载不出来
      </h1>
      <p
        style={{
          color: "rgba(235,235,245,0.60)",
          fontSize: 14,
          lineHeight: 1.7,
          marginBottom: 28,
        }}
      >
        可能是上游数据源一时繁忙。稍等片刻再试，通常很快就好。
        <br />
        <span style={{ color: "rgba(235,235,245,0.40)", fontSize: 13 }}>
          Couldn&apos;t load this page right now — please try again.
        </span>
      </p>
      <div
        style={{
          display: "flex",
          gap: 12,
          justifyContent: "center",
          flexWrap: "wrap",
        }}
      >
        <button type="button" onClick={() => reset()} style={primaryBtn}>
          重试
        </button>
        <Link href="/" style={secondaryBtn}>
          返回首页
        </Link>
      </div>
      {error.digest && (
        <p
          style={{
            marginTop: 24,
            color: "rgba(235,235,245,0.25)",
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {error.digest}
        </p>
      )}
    </main>
  );
}
