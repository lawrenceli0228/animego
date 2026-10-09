package community

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Messages the API answers with.  English, like every other handler package:
// the page shows its own localized text, chosen by status code and by the
// limits it checks before sending.
const (
	msgInvalidParams          = "Invalid params"
	msgInvalidBody            = "Invalid request body"
	msgLoginAgain             = "Please log in again"
	msgAnimeNotFound          = "Anime not found"
	msgReviewNotFound         = "Review not found"
	msgThreadNotFound         = "Thread not found"
	msgActivityNotFound       = "Activity not found"
	msgReplyNotFound          = "Reply not found"
	msgParentNotFound         = "Parent reply not found"
	msgSummaryLength          = "Summary must be 10-60 characters"
	msgReviewTooShort         = "Review must be at least 300 characters"
	msgReviewTooLong          = "Review is too long"
	msgTitleLength            = "Title must be 4-80 characters"
	msgContentRequired        = "Content is required"
	msgJSONOnly               = "Content-Type must be application/json"
	msgContentTooLong         = "Content too long"
	msgAlreadyReviewed        = "You have already reviewed this anime"
	msgNotYourReview          = "Not your review"
	msgNotYourThread          = "Not your thread"
	msgNotYourReply           = "Not your reply"
	msgOwnReview              = "Cannot vote on your own review"
	msgInteractionUnavailable = "Interaction unavailable"
	msgTooManyRequests        = "Too many requests, please try again later"
)

// Length limits, in characters (code points).  The migration's CHECKs say
// the same numbers; a payload that passes here cannot fail them.
const (
	reviewSummaryMin = 10
	reviewSummaryMax = 60
	reviewBodyMin    = 300
	reviewBodyMax    = 20000
	threadTitleMin   = 4
	threadTitleMax   = 80
	threadBodyMax    = 5000
	replyBodyMax     = 500
)

// normalizeBody prepares multi-line text for storage: line endings become
// \n, control characters other than \n and \t are dropped (Postgres refuses
// a NUL outright, which would otherwise be a 500), and the ends are trimmed.
func normalizeBody(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}

// normalizeLine prepares single-line text (a review summary, a thread
// title): every run of whitespace, line breaks included, becomes one space.
func normalizeLine(s string) string {
	return strings.Join(strings.Fields(normalizeBody(s)), " ")
}

// isBlank reports whether s has nothing a reader could see: only
// whitespace and invisible format characters (zero-width spaces, joiners,
// a byte-order mark).  "  ZWSP " is as empty as "".
func isBlank(s string) bool { return visibleLength(s) == 0 }

// visibleLength is what the minimums are measured in: characters a reader
// can see, with each run of whitespace counted once and characters that
// draw nothing (see invisible) not at all.  "好", four hundred spaces and "好"
// is three characters, not 402 -- padding is not writing.  Ordinary prose
// is unaffected: a space between words or the break between two paragraphs
// counts as one character, the way a writer expects.  The page's counter
// (lib/community/textLimits.ts) measures the same way.
func visibleLength(s string) int {
	n := 0
	pendingSpace := false
	for _, r := range s {
		switch {
		case invisible(r):
			continue
		case unicode.IsSpace(r):
			pendingSpace = n > 0
		default:
			if pendingSpace {
				n++
				pendingSpace = false
			}
			n++
		}
	}
	return n
}

// invisible is a character that draws nothing a reader would count: format
// characters (unicode.Cf: zero-width spaces and joiners, the BOM), marks
// (Mn, Me: combining accents and variation selectors, which belong to the
// character before them), and the fillers fonts draw as blank — the Hangul
// fillers and the Braille blank.  textLimits.ts skips the same set.
func invisible(r rune) bool {
	switch r {
	case 0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800:
		return true
	}
	return unicode.In(r, unicode.Cf, unicode.Mn, unicode.Me)
}

// runeCount is what the maximums are measured in: the stored length, the
// same count Postgres's char_length gives, so text that passes here can
// never trip the CHECK.
func runeCount(s string) int { return utf8.RuneCountInString(s) }

// reviewInput is a validated review body.
type reviewInput struct {
	Summary   string
	Body      string
	IsSpoiler bool
	IsPrivate bool
}

// validateReview normalizes and checks a review, returning the message to
// answer with when it fails.
func validateReview(summary, body string, isSpoiler, isPrivate bool) (reviewInput, string) {
	summary = normalizeLine(summary)
	body = normalizeBody(body)
	if visibleLength(summary) < reviewSummaryMin || runeCount(summary) > reviewSummaryMax {
		return reviewInput{}, msgSummaryLength
	}
	if visibleLength(body) < reviewBodyMin {
		return reviewInput{}, msgReviewTooShort
	}
	if runeCount(body) > reviewBodyMax {
		return reviewInput{}, msgReviewTooLong
	}
	return reviewInput{Summary: summary, Body: body, IsSpoiler: isSpoiler, IsPrivate: isPrivate}, ""
}

// validateThread normalizes and checks a new thread's title and body.
func validateThread(title, body string) (string, string, string) {
	title = normalizeLine(title)
	body = normalizeBody(body)
	if visibleLength(title) < threadTitleMin || runeCount(title) > threadTitleMax {
		return "", "", msgTitleLength
	}
	if isBlank(body) {
		return "", "", msgContentRequired
	}
	if runeCount(body) > threadBodyMax {
		return "", "", msgContentTooLong
	}
	return title, body, ""
}

// validateReply normalizes and checks a reply's text.
func validateReply(body string) (string, string) {
	body = normalizeBody(body)
	if isBlank(body) {
		return "", msgContentRequired
	}
	if runeCount(body) > replyBodyMax {
		return "", msgContentTooLong
	}
	return body, ""
}
