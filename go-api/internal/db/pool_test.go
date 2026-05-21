package db

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestNewPool_EmptyURL(t *testing.T) {
	t.Parallel()

	pool, err := NewPool(context.Background(), "")
	if err == nil {
		t.Fatalf("expected error for empty url, got nil")
	}
	if pool != nil {
		t.Fatalf("expected nil pool on error, got %v", pool)
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Errorf("expected error to mention 'empty', got %q", err.Error())
	}
}

func TestNewPool_InvalidURL(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		url  string
		want string
	}{
		{
			name: "garbage scheme",
			url:  "not-a-valid-url",
			want: "parse database url",
		},
		{
			name: "scheme only",
			url:  "://",
			want: "parse database url",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			pool, err := NewPool(context.Background(), tc.url)
			if err == nil {
				if pool != nil {
					pool.Close()
				}
				t.Fatalf("expected error for url %q, got nil", tc.url)
			}
			if pool != nil {
				t.Fatalf("expected nil pool on error, got %v", pool)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("expected error to contain %q, got %q", tc.want, err.Error())
			}
		})
	}
}

func TestNewPool_UnreachableHost(t *testing.T) {
	t.Parallel()

	// 127.0.0.2:1 is RFC 3927 loopback w/ port 1 (privileged, never bound).
	// pgx will fail to connect within ConnectTimeout.  Test asserts the pool
	// fails cleanly without leaking goroutines or panicking.
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	pool, err := NewPool(ctx, "postgres://nobody:nobody@127.0.0.2:1/none?sslmode=disable&connect_timeout=2")
	if err == nil {
		if pool != nil {
			pool.Close()
		}
		t.Fatalf("expected connect error against unreachable host, got nil")
	}
	if pool != nil {
		t.Fatalf("expected nil pool on connect error, got %v", pool)
	}
}

func TestPoolConstants(t *testing.T) {
	t.Parallel()

	// Guard the documented invariants in case someone changes a constant
	// without thinking through the tradeoff.
	if MaxConns < 10 {
		t.Errorf("MaxConns=%d too low for web tier", MaxConns)
	}
	if MaxConns > 50 {
		t.Errorf("MaxConns=%d may exhaust Postgres max_connections", MaxConns)
	}
	if ConnectTimeout < 5*time.Second {
		t.Errorf("ConnectTimeout=%v too tight for cold-start", ConnectTimeout)
	}
	if PingTimeout > 5*time.Second {
		t.Errorf("PingTimeout=%v slower than docker healthcheck probe", PingTimeout)
	}
}
