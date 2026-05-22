// bangumi_v3_test.go — unit tests for the Phase 3 heal-CN worker.
//
// No real Bangumi HTTP server, no real DB.  Each test wires a fake
// BangumiSubjector + V3DB and asserts:
//
//   - Subject NameCN populated → UpdateBangumiV3 with &name_cn.
//   - Subject NameCN empty → UpdateBangumiV3 with nil titleChinese.
//   - Subject 404 (ErrNotFound) → still UpdateBangumiV3 with nil
//     (terminal heal: bump version=3 regardless).
//   - Transient Subject error → surface for river retry, no DB write.
//   - DB error → surface for river retry.
//   - Construction with nil deps doesn't panic (Work would error).
//
// In-package tests so we can reuse the ptr[T] generic + share the
// BangumiSubjector interface defined in bangumi_v2.go.
package queue

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"

	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// fakeBangumiV3 is a programmable BangumiSubjector.  Each test wires
// subjectFn to control upstream behaviour; calls are recorded so
// negative assertions ("must NOT call Subject") stay precise.
type fakeBangumiV3 struct {
	mu sync.Mutex

	subjectFn func(ctx context.Context, bgmID int) (*bangumi.Subject, error)

	subjectCalls  int
	lastSubjectID int
}

func (f *fakeBangumiV3) Subject(ctx context.Context, bgmID int) (*bangumi.Subject, error) {
	f.mu.Lock()
	f.subjectCalls++
	f.lastSubjectID = bgmID
	fn := f.subjectFn
	f.mu.Unlock()
	if fn == nil {
		return &bangumi.Subject{ID: bgmID}, nil
	}
	return fn(ctx, bgmID)
}

// v3UpdateCall snapshots one UpdateBangumiV3 invocation.
type v3UpdateCall struct {
	anilistID    int32
	titleChinese *string
}

// fakeV3DB is a programmable V3DB.  updateFn lets tests inject an
// error; call snapshots let assertions inspect what got written.
type fakeV3DB struct {
	mu sync.Mutex

	updateFn func(ctx context.Context, c v3UpdateCall) error

	updateCalls []v3UpdateCall
}

func (f *fakeV3DB) UpdateBangumiV3(ctx context.Context, anilistID int32, titleChinese *string) error {
	call := v3UpdateCall{
		anilistID:    anilistID,
		titleChinese: titleChinese,
	}
	f.mu.Lock()
	f.updateCalls = append(f.updateCalls, call)
	fn := f.updateFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, call)
}

func (f *fakeV3DB) snapshotCalls() []v3UpdateCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]v3UpdateCall, len(f.updateCalls))
	copy(dup, f.updateCalls)
	return dup
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// runV3 constructs the worker + a stock job and dispatches via Work().
func runV3(t *testing.T, b BangumiSubjector, d V3DB, anilistID, bgmID int) error {
	t.Helper()
	w := NewBangumiV3Worker(b, d)
	return w.Work(context.Background(), &river.Job[BangumiV3Args]{
		Args: BangumiV3Args{AnilistID: anilistID, BgmID: bgmID},
	})
}

// runV3Ctx is a runV3 variant that lets the caller supply a context
// (e.g. pre-canceled) instead of context.Background().
func runV3Ctx(t *testing.T, ctx context.Context, b BangumiSubjector, d V3DB, anilistID, bgmID int) error {
	t.Helper()
	w := NewBangumiV3Worker(b, d)
	return w.Work(ctx, &river.Job[BangumiV3Args]{
		Args: BangumiV3Args{AnilistID: anilistID, BgmID: bgmID},
	})
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestBangumiV3_HappyPath_SubjectHasNameCN — Subject returns name_cn →
// UpdateBangumiV3 called with &name_cn.
func TestBangumiV3_HappyPath_SubjectHasNameCN(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, bgmID int) (*bangumi.Subject, error) {
			require.Equal(t, 9999, bgmID)
			return &bangumi.Subject{ID: 9999, Name: "Naruto", NameCN: "火影忍者"}, nil
		},
	}
	db := &fakeV3DB{}

	err := runV3(t, b, db, 1234, 9999)
	require.NoError(t, err)

	calls := db.snapshotCalls()
	require.Len(t, calls, 1, "exactly one UpdateBangumiV3 call expected")
	assert.Equal(t, int32(1234), calls[0].anilistID)
	require.NotNil(t, calls[0].titleChinese, "Subject.NameCN populated → titleChinese should be non-nil")
	assert.Equal(t, "火影忍者", *calls[0].titleChinese)

	assert.Equal(t, 1, b.subjectCalls, "Subject called exactly once")
	assert.Equal(t, 9999, b.lastSubjectID, "bgmId propagated to Subject")
}

// TestBangumiV3_SubjectNameCNEmpty_PassesNil — Subject returns
// NameCN="" → UpdateBangumiV3 called with nil titleChinese (SQL writes
// NULL).
func TestBangumiV3_SubjectNameCNEmpty_PassesNil(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return &bangumi.Subject{ID: 100, Name: "Title", NameCN: ""}, nil
		},
	}
	db := &fakeV3DB{}

	err := runV3(t, b, db, 1, 100)
	require.NoError(t, err)

	calls := db.snapshotCalls()
	require.Len(t, calls, 1)
	assert.Nil(t, calls[0].titleChinese, "empty NameCN → nil titleChinese")
}

// TestBangumiV3_SubjectNotFound_StillBumpsVersion — Subject 404 is a
// SOFT failure for V3.  We still call UpdateBangumiV3 (which bumps
// version=3) with nil titleChinese.  V3 is terminal: heal attempt
// complete, no more retries.
func TestBangumiV3_SubjectNotFound_StillBumpsVersion(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return nil, bangumi.ErrNotFound
		},
	}
	db := &fakeV3DB{}

	err := runV3(t, b, db, 1, 100)
	require.NoError(t, err, "ErrNotFound on Subject must NOT retry — V3 is terminal")

	calls := db.snapshotCalls()
	require.Len(t, calls, 1, "even on 404, UpdateBangumiV3 must run to bump version=3")
	assert.Equal(t, int32(1), calls[0].anilistID)
	assert.Nil(t, calls[0].titleChinese, "Subject 404 → nil titleChinese")
}

// TestBangumiV3_SubjectTransientError_RetriesUp — non-NotFound errors
// must surface so river retries the whole job.  No DB write should
// happen (don't half-update the row).
func TestBangumiV3_SubjectTransientError_RetriesUp(t *testing.T) {
	t.Parallel()

	upstream := &bangumi.ErrUpstream{Status: 503, Message: "Bangumi API error"}
	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return nil, upstream
		},
	}
	db := &fakeV3DB{}

	err := runV3(t, b, db, 1, 100)
	require.Error(t, err, "503 must surface for river retry")
	assert.ErrorIs(t, err, upstream)
	assert.Empty(t, db.snapshotCalls(), "transient Subject error → NO DB write")
}

// TestBangumiV3_DBUpdateError_RetriesUp — UpdateBangumiV3 errors must
// surface so river retries.
func TestBangumiV3_DBUpdateError_RetriesUp(t *testing.T) {
	t.Parallel()

	dbErr := errors.New("write conflict")
	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return &bangumi.Subject{ID: 100, NameCN: "标题"}, nil
		},
	}
	db := &fakeV3DB{
		updateFn: func(_ context.Context, _ v3UpdateCall) error {
			return dbErr
		},
	}

	err := runV3(t, b, db, 1, 100)
	require.Error(t, err, "DB error must surface for river retry")
	assert.ErrorIs(t, err, dbErr)
	// One attempt was made — the call IS recorded, the error is what
	// surfaces.
	assert.Len(t, db.snapshotCalls(), 1, "UpdateBangumiV3 attempted exactly once")
}

// TestBangumiV3_DBUpdateError_OnNotFound_AlsoRetries — even when
// Subject 404s, a DB error on the version-bump UPDATE must surface so
// river retries (the heal attempt isn't truly complete until the row
// is at version=3).
func TestBangumiV3_DBUpdateError_OnNotFound_AlsoRetries(t *testing.T) {
	t.Parallel()

	dbErr := errors.New("write conflict")
	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return nil, bangumi.ErrNotFound
		},
	}
	db := &fakeV3DB{
		updateFn: func(_ context.Context, _ v3UpdateCall) error {
			return dbErr
		},
	}

	err := runV3(t, b, db, 1, 100)
	require.Error(t, err)
	assert.ErrorIs(t, err, dbErr)
	assert.Len(t, db.snapshotCalls(), 1)
}

// TestBangumiV3_ContextCanceled_NoUpdate — pre-canceled ctx →
// Subject call should propagate ctx.Err() (no DB write).  We don't
// assert the exact error shape — bangumi.Client maps it to a transport
// error, the worker wraps and returns.
func TestBangumiV3_ContextCanceled_NoUpdate(t *testing.T) {
	t.Parallel()

	cancelledCtx, cancel := context.WithCancel(context.Background())
	cancel()

	b := &fakeBangumiV3{
		subjectFn: func(ctx context.Context, _ int) (*bangumi.Subject, error) {
			// Honour ctx cancellation — what *bangumi.Client does.
			return nil, ctx.Err()
		},
	}
	db := &fakeV3DB{}

	err := runV3Ctx(t, cancelledCtx, b, db, 1, 100)
	require.Error(t, err, "canceled ctx must surface")
	assert.ErrorIs(t, err, context.Canceled)
	assert.Empty(t, db.snapshotCalls(), "canceled ctx → NO DB write")
}

// TestBangumiV3_ZeroAnilistID_StillRuns — the worker doesn't validate
// AnilistID=0; that's the upstream's responsibility.  We dispatch the
// Subject fetch and UpdateBangumiV3 (which will hit the WHERE
// anilist_id=0 clause and update zero rows — harmless).
func TestBangumiV3_ZeroAnilistID_StillRuns(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return &bangumi.Subject{ID: 100, NameCN: "标题"}, nil
		},
	}
	db := &fakeV3DB{}

	err := runV3(t, b, db, 0, 100)
	require.NoError(t, err)

	calls := db.snapshotCalls()
	require.Len(t, calls, 1)
	assert.Equal(t, int32(0), calls[0].anilistID, "AnilistID=0 propagates as-is")
}

// TestBangumiV3_ZeroBgmID_StillCallsSubject — boundary: BgmID=0 isn't
// pre-validated.  Subject fetch happens (will likely 404 in
// production but that's the bangumi.Client's contract).
func TestBangumiV3_ZeroBgmID_StillCallsSubject(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, bgmID int) (*bangumi.Subject, error) {
			assert.Equal(t, 0, bgmID, "BgmID=0 propagates to Subject")
			return nil, bangumi.ErrNotFound
		},
	}
	db := &fakeV3DB{}

	err := runV3(t, b, db, 1, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, b.subjectCalls, "Subject still called even with BgmID=0")
	// 404 path → still UPDATE to bump version.
	assert.Len(t, db.snapshotCalls(), 1)
}

// TestBangumiV3_HappyPath_Logging — assert the "v3 done" log line
// includes the structured fields dashboards rely on.  Uses a buffer-
// backed slog handler so we don't need a real log sink.
//
// NOT t.Parallel — slog.Default is process-global state.
func TestBangumiV3_HappyPath_Logging(t *testing.T) {
	original := slog.Default()
	t.Cleanup(func() { slog.SetDefault(original) })

	buf := &bytes.Buffer{}
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	})))

	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return &bangumi.Subject{ID: 100, NameCN: "标题"}, nil
		},
	}
	db := &fakeV3DB{}

	require.NoError(t, runV3(t, b, db, 12345, 999))

	out := buf.String()
	assert.Contains(t, out, "bangumi_v3 done", "log line should identify v3 completion")
	assert.Contains(t, out, "anilistId=12345", "log line should include AnilistID")
	assert.Contains(t, out, "bgmId=999", "log line should include BgmID")
	assert.Contains(t, out, "hasChinese=true", "log line should report CN presence")
}

// TestBangumiV3_NoSubjectLogging — 404 path logs the dedicated
// "no_subject" line so dashboards can distinguish from "done".
//
// NOT t.Parallel — slog.Default is process-global state.
func TestBangumiV3_NoSubjectLogging(t *testing.T) {
	original := slog.Default()
	t.Cleanup(func() { slog.SetDefault(original) })

	buf := &bytes.Buffer{}
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	})))

	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return nil, bangumi.ErrNotFound
		},
	}
	db := &fakeV3DB{}

	require.NoError(t, runV3(t, b, db, 12345, 999))

	out := buf.String()
	assert.Contains(t, out, "bangumi_v3 no_subject", "404 should log no_subject line")
	assert.Contains(t, out, "anilistId=12345")
}

// TestNewBangumiV3Worker_NilDeps_DoesNotPanic — construction must be
// safe with nil deps.  Work would panic on the first dispatch, but
// the constructor itself should not.
func TestNewBangumiV3Worker_NilDeps_DoesNotPanic(t *testing.T) {
	t.Parallel()

	assert.NotPanics(t, func() {
		w := NewBangumiV3Worker(nil, nil)
		require.NotNil(t, w, "constructor must return a non-nil worker even with nil deps")
	})
}

// ---------------------------------------------------------------------------
// Compile-time guards: production types must satisfy the interfaces.
// ---------------------------------------------------------------------------

// dbgen.Querier must satisfy V3DB so main.go can pass *Queries directly.
var _ V3DB = (dbgen.Querier)(nil)
