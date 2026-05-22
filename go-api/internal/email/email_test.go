package email

// email_test.go — unit coverage for SMTPSender + NoopSender + the
// RFC822 message builder.  Stdlib + testify only; no real SMTP calls.
// The sendFn-injection seam on *SMTPSender lets us assert the exact
// bytes that would have been written to the wire without standing up
// a server.

import (
	"context"
	"net/smtp"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewSMTPSender_EmptyUser_ReturnsError(t *testing.T) {
	t.Parallel()

	s, err := NewSMTPSender("", "app-password")
	require.Error(t, err)
	require.Nil(t, s)
	assert.Contains(t, err.Error(), "GMAIL_USER")
}

func TestNewSMTPSender_EmptyPassword_ReturnsError(t *testing.T) {
	t.Parallel()

	s, err := NewSMTPSender("u@example.com", "")
	require.Error(t, err)
	require.Nil(t, s)
	assert.Contains(t, err.Error(), "GMAIL_APP_PASSWORD")
}

func TestNewSMTPSender_HappyPath(t *testing.T) {
	t.Parallel()

	s, err := NewSMTPSender("u@example.com", "abcd1234efgh5678")
	require.NoError(t, err)
	require.NotNil(t, s)
	assert.Equal(t, "smtp.gmail.com:587", s.host)
	assert.Equal(t, "u@example.com", s.user)
	assert.Equal(t, "abcd1234efgh5678", s.appPassword)
	assert.Equal(t, "AnimeGo <u@example.com>", s.fromHeader)
	assert.NotNil(t, s.sendFn, "sendFn should default to smtp.SendMail")
}

func TestNewSMTPSender_AppPasswordWhitespace_Stripped(t *testing.T) {
	t.Parallel()

	// Gmail's UI displays App Passwords as four 4-char groups.  Users
	// frequently copy that displayed form.  We strip spaces so either
	// "abcd efgh ijkl mnop" or "abcdefghijklmnop" works.
	s, err := NewSMTPSender("u@example.com", "abcd efgh ijkl mnop")
	require.NoError(t, err)
	assert.Equal(t, "abcdefghijklmnop", s.appPassword)
}

func TestNoopSender_SendPasswordReset_NoError(t *testing.T) {
	t.Parallel()

	var n NoopSender
	err := n.SendPasswordReset(context.Background(), "user@example.com", "https://example.com/reset/abc")
	assert.NoError(t, err)
}

func TestSMTPSender_SendPasswordReset_ContextCanceled(t *testing.T) {
	t.Parallel()

	s, err := NewSMTPSender("u@example.com", "pw")
	require.NoError(t, err)

	// Inject a sendFn that records calls so we can prove it was never
	// invoked.
	var called bool
	s.sendFn = func(_ string, _ smtp.Auth, _ string, _ []string, _ []byte) error {
		called = true
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already done before the call

	err = s.SendPasswordReset(ctx, "user@example.com", "https://example.com/reset/abc")
	require.ErrorIs(t, err, context.Canceled)
	assert.False(t, called, "sendFn must not be called after ctx canceled")
}

// fakeSend is a thread-safe sendFn stub that captures the most recent
// call's arguments for assertions.
type fakeSend struct {
	mu     sync.Mutex
	called bool
	addr   string
	auth   smtp.Auth
	from   string
	to     []string
	msg    []byte
	err    error
}

func (f *fakeSend) Send(addr string, a smtp.Auth, from string, to []string, msg []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.called = true
	f.addr = addr
	f.auth = a
	f.from = from
	f.to = append([]string(nil), to...)
	f.msg = append([]byte(nil), msg...)
	return f.err
}

func TestSMTPSender_SendPasswordReset_HappyPath_SendFnCalled(t *testing.T) {
	t.Parallel()

	s, err := NewSMTPSender("sender@example.com", "app-password")
	require.NoError(t, err)

	fs := &fakeSend{}
	s.sendFn = fs.Send

	err = s.SendPasswordReset(context.Background(), "recipient@example.com", "https://app.example.com/reset-password/abc123")
	require.NoError(t, err)
	require.True(t, fs.called, "sendFn should have been invoked")

	assert.Equal(t, "smtp.gmail.com:587", fs.addr)
	assert.Equal(t, "sender@example.com", fs.from)
	assert.Equal(t, []string{"recipient@example.com"}, fs.to)
	assert.NotNil(t, fs.auth, "PlainAuth should be constructed")

	msg := string(fs.msg)
	// Header presence + ordering anchors.
	assert.Contains(t, msg, "From: AnimeGo <sender@example.com>\r\n")
	assert.Contains(t, msg, "To: recipient@example.com\r\n")
	// mime.BEncoding.Encode emits a lowercase `b` charset marker; both
	// forms are RFC 2047 compliant.
	assert.Contains(t, msg, "Subject: =?utf-8?b?", "Subject must be RFC 2047 base64 encoded")
	assert.Contains(t, msg, "MIME-Version: 1.0\r\n")
	assert.Contains(t, msg, "Content-Type: text/html; charset=utf-8\r\n")
	assert.Contains(t, msg, "Content-Transfer-Encoding: 8bit\r\n")
	// Header/body separator + body content.
	assert.Contains(t, msg, "\r\n\r\n")
	assert.Contains(t, msg, "https://app.example.com/reset-password/abc123", "URL must appear in body")
	assert.Contains(t, msg, "重置你的密码", "Chinese body text must appear verbatim")
}

func TestSMTPSender_SendPasswordReset_SendFnError_Propagated(t *testing.T) {
	t.Parallel()

	s, err := NewSMTPSender("sender@example.com", "app-password")
	require.NoError(t, err)

	fs := &fakeSend{err: assert.AnError}
	s.sendFn = fs.Send

	err = s.SendPasswordReset(context.Background(), "recipient@example.com", "https://x/y")
	require.Error(t, err)
	assert.ErrorIs(t, err, assert.AnError, "wrapper should preserve the underlying error via %w")
	assert.Contains(t, err.Error(), "email: SendMail:", "error should be wrapped with package context")
}

func TestBuildRFC822Message_Headers_Order_CRLF(t *testing.T) {
	t.Parallel()

	msg := buildRFC822Message(
		"AnimeGo <sender@example.com>",
		"recipient@example.com",
		"【AnimeGo】重置你的密码",
		"<p>hello</p>",
	)
	s := string(msg)

	// Must start with From:.
	assert.True(t, strings.HasPrefix(s, "From: AnimeGo <sender@example.com>\r\n"), "must start with From header")

	// Subject is RFC 2047 base64-encoded (lowercase `b` per mime stdlib).
	assert.Contains(t, s, "Subject: =?utf-8?b?")
	assert.Contains(t, s, "?=\r\n", "encoded-word must terminate with ?=")

	// MIME triplet present and in order.
	mimeIdx := strings.Index(s, "MIME-Version: 1.0\r\n")
	ctIdx := strings.Index(s, "Content-Type: text/html; charset=utf-8\r\n")
	cteIdx := strings.Index(s, "Content-Transfer-Encoding: 8bit\r\n")
	assert.Greater(t, mimeIdx, 0)
	assert.Greater(t, ctIdx, mimeIdx, "Content-Type must follow MIME-Version")
	assert.Greater(t, cteIdx, ctIdx, "Content-Transfer-Encoding must follow Content-Type")

	// Header/body separator + body afterwards.
	sepIdx := strings.Index(s, "\r\n\r\n")
	assert.Greater(t, sepIdx, cteIdx, "blank separator must come after all headers")
	bodyStart := sepIdx + len("\r\n\r\n")
	assert.Equal(t, "<p>hello</p>", s[bodyStart:], "body must follow the separator verbatim")
}

func TestMaskedEmail(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		in   string
		want string
	}{
		{"normal", "alice@example.com", "a***@example.com"},
		{"empty", "", ""},
		{"short_local", "ab@x.com", "a***@x.com"},
		{"single_char_local", "a@b.io", "a***@b.io"},
		{"no_at_sign", "no-at-sign", "***"},
		{"leading_at", "@example.com", "***"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, maskedEmail(tc.in))
		})
	}
}

func TestStripAllWhitespace(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in   string
		want string
	}{
		{"abcd efgh ijkl mnop", "abcdefghijklmnop"},
		{"\tfoo\nbar\r", "foobar"},
		{"nospaces", "nospaces"},
		{"", ""},
	}
	for _, tc := range cases {
		assert.Equal(t, tc.want, stripAllWhitespace(tc.in))
	}
}

// Sanity: the package-level compile-time interface guards exist.  This
// "test" is a redundant runtime check that also catches accidental
// interface-method drift; cheap and worth keeping.
func TestSenderInterface_Implementations(t *testing.T) {
	t.Parallel()

	var _ Sender = (*SMTPSender)(nil)
	var _ Sender = NoopSender{}
}
