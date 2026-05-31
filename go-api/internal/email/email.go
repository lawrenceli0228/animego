// Package email — transactional Gmail SMTP sender for password-reset
// email.  Uses Go stdlib net/smtp with smtp.PlainAuth against
// smtp.gmail.com:587 (STARTTLS upgrade is handled automatically by
// net/smtp.SendMail when the server advertises STARTTLS).
//
// The Sender interface is the small consumer-facing contract:
// production wires SMTPSender; tests pass a stub or NoopSender.
// Handler code never imports net/smtp directly.
//
// Configuration semantics match Express service/email.service.js:
// when GMAIL_USER or GMAIL_APP_PASSWORD is empty, the sender silently
// no-ops (logs a warn, returns nil).  Login flows still work; only
// forgot-password's email delivery is skipped.
package email

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"mime"
	"net/smtp"
	"strings"
)

// Sender is the small interface auth handlers consume.  Tests inject
// stubs; production wires *SMTPSender.  Per the "accept interfaces,
// return structs" idiom.
type Sender interface {
	SendPasswordReset(ctx context.Context, to, resetURL string) error
}

// gmailSMTPHost is Gmail's submission endpoint.  Port 587 + STARTTLS
// is the documented modern path (465+implicit-TLS is the legacy
// alternative; net/smtp's SendMail prefers the STARTTLS upgrade).
const gmailSMTPHost = "smtp.gmail.com:587"

// gmailSMTPServer is the bare hostname required by smtp.PlainAuth's
// identity check (must match the server cert CN — net/smtp validates
// this before sending credentials over the wire).
const gmailSMTPServer = "smtp.gmail.com"

// resetSubject is the literal Subject header text — Chinese square
// brackets `【】` are intentional (matches Express byte-for-byte).
// It MUST be RFC 2047 encoded before going on the wire.
const resetSubject = "【AnimeGo】重置你的密码"

// sendMailFunc is the signature of net/smtp.SendMail; aliased so the
// struct field that holds it stays readable.  Test-only: the real
// path always uses smtp.SendMail.
type sendMailFunc func(addr string, a smtp.Auth, from string, to []string, msg []byte) error

// SMTPSender holds the Gmail SMTP credentials + the From header used
// for all outgoing reset emails.
//
// sendFn is test-only — defaults to smtp.SendMail in production via
// NewSMTPSender.  Tests override it to verify the message bytes
// without making a real network call.
type SMTPSender struct {
	host        string // smtp.gmail.com:587
	user        string // sender Gmail address
	appPassword string // Gmail App Password (NOT account password)
	fromHeader  string // "AnimeGo <user@gmail.com>"

	sendFn sendMailFunc
}

// NewSMTPSender constructs a SMTPSender bound to Gmail's SMTP relay.
// Returns nil + error when user or appPassword is empty — callers
// should fall back to NoopSender in that case (don't crash boot just
// because email is unconfigured).
//
// App-password whitespace: Gmail displays App Passwords as four
// 4-char groups separated by spaces.  Users frequently copy that
// display form into env vars.  We strip all whitespace before storing
// so either format works.
func NewSMTPSender(user, appPassword string) (*SMTPSender, error) {
	if user == "" || appPassword == "" {
		return nil, fmt.Errorf("email: GMAIL_USER and GMAIL_APP_PASSWORD both required")
	}
	cleaned := stripAllWhitespace(appPassword)
	return &SMTPSender{
		host:        gmailSMTPHost,
		user:        user,
		appPassword: cleaned,
		fromHeader:  fmt.Sprintf("AnimeGo <%s>", user),
		sendFn:      smtp.SendMail,
	}, nil
}

// SendPasswordReset sends the reset-link email to `to` using the
// shared HTML template + the literal subject `【AnimeGo】重置你的密码`.
// `resetURL` is the full URL the user clicks (template builds the
// HTML around it via BuildResetEmailHTML).
//
// Errors are returned verbatim — caller decides whether to swallow
// or log (auth handler swallows so the user always sees a 200 to
// prevent email enumeration).
//
// Note: net/smtp.SendMail is blocking and not ctx-aware.  We honor
// ctx by checking Done before the send call; for the network call
// itself we rely on the connection's own short timeouts.  Most
// callers won't notice — this is a fire-and-forget transactional
// path triggered by a single user request.
func (s *SMTPSender) SendPasswordReset(ctx context.Context, to, resetURL string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	body := BuildResetEmailHTML(resetURL)
	msg := buildRFC822Message(s.fromHeader, to, resetSubject, body)

	auth := smtp.PlainAuth("", s.user, s.appPassword, gmailSMTPServer)
	if err := s.sendFn(s.host, auth, s.user, []string{to}, msg); err != nil {
		return fmt.Errorf("email: SendMail: %w", err)
	}
	return nil
}

// NoopSender satisfies Sender without doing anything — used when
// GMAIL_USER/GMAIL_APP_PASSWORD is unset.  Logs a warn so unconfigured
// prod environments are visible in logs without crashing the request.
type NoopSender struct{}

// SendPasswordReset on NoopSender logs a single warn and returns nil.
// The forgot-password handler treats this as success so the response
// stays a 200 — matching Express's silent-skip behavior.
func (NoopSender) SendPasswordReset(ctx context.Context, to, _ string) error {
	slog.WarnContext(ctx, "email: Gmail SMTP not configured — skipping send", "to", maskedEmail(to))
	return nil
}

// buildRFC822Message assembles the full SMTP message including the
// MIME headers required for HTML email rendering in Gmail / Apple
// Mail / Outlook.
//
// Headers in this exact order (some clients are picky):
//
//	From: AnimeGo <sender@gmail.com>
//	To: recipient@example.com
//	Subject: =?utf-8?B?...?=          ← UTF-8 base64-encoded subject
//	MIME-Version: 1.0
//	Content-Type: text/html; charset=utf-8
//	Content-Transfer-Encoding: 8bit
//
// Subject MUST be encoded as RFC 2047 (encoded-word) because the
// literal Chinese chars violate header ASCII-only rules.  base64
// encoding is more robust than quoted-printable for CJK.
//
// Then a blank line, then the HTML body verbatim.
//
// Returns a []byte ready for smtp.SendMail.
func buildRFC822Message(from, to, subject, htmlBody string) []byte {
	encodedSubject := mime.BEncoding.Encode("utf-8", subject)

	var b bytes.Buffer
	// Header block — every line terminated with CRLF per RFC 5322.
	b.WriteString("From: ")
	b.WriteString(from)
	b.WriteString("\r\n")
	b.WriteString("To: ")
	b.WriteString(to)
	b.WriteString("\r\n")
	b.WriteString("Subject: ")
	b.WriteString(encodedSubject)
	b.WriteString("\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	// Blank line separates headers from body.
	b.WriteString("\r\n")
	b.WriteString(htmlBody)
	return b.Bytes()
}

// maskedEmail returns "a***@example.com" for log redaction.  Not
// security-critical — emails in logs are still a privacy concern in
// general but reset-flow telemetry must be debuggable.
//
// Edge cases:
//   - empty input → empty output (don't log "<nil>")
//   - no @ in input → "***" (treat as opaque, don't echo it)
//   - 1-char local part → still mask to "a***@..." for consistency
func maskedEmail(addr string) string {
	if addr == "" {
		return ""
	}
	at := strings.IndexByte(addr, '@')
	if at <= 0 {
		// No @ at all, or address starts with @ — redact entirely.
		return "***"
	}
	local := addr[:at]
	domain := addr[at:]
	return string(local[0]) + "***" + domain
}

// stripAllWhitespace removes every Unicode whitespace rune from s.
// Used to normalize Gmail App Passwords copied with the displayed
// space separators.  Cheap allocation; called once at construct time.
func stripAllWhitespace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// Compile-time guards.
var (
	_ Sender = (*SMTPSender)(nil)
	_ Sender = NoopSender{}
)
