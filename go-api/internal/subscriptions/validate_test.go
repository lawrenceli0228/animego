package subscriptions

// validate_test.go — unit coverage for the validator → message map and
// the score clamp.  These helpers have no DB dependency, so they live
// outside the testcontainer-backed handler tests.

import (
	"errors"
	"testing"

	"github.com/go-playground/validator/v10"
)

// makeValidator returns a fresh validator with required-struct enabled,
// matching the production NewHandlers default.
func makeValidator(t *testing.T) *validator.Validate {
	t.Helper()
	return validator.New(validator.WithRequiredStructEnabled())
}

// runStructValidation runs validator.Struct against `req` and returns
// the error (or nil on success).  Test convenience.
func runStructValidation(t *testing.T, v *validator.Validate, req any) error {
	t.Helper()
	return v.Struct(req)
}

func TestValidationMessage_CreateAnilistID(t *testing.T) {
	t.Parallel()
	v := makeValidator(t)

	cases := []struct {
		name string
		req  createSubscriptionReq
	}{
		{"zero anilistId", createSubscriptionReq{AnilistID: 0, Status: "watching"}},
		{"negative anilistId", createSubscriptionReq{AnilistID: -5, Status: "watching"}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := runStructValidation(t, v, &tc.req)
			if err == nil {
				t.Fatalf("expected validation error, got nil")
			}
			got := validationMessage(err)
			if got != msgInvalidAnimeID {
				t.Errorf("validationMessage = %q, want %q", got, msgInvalidAnimeID)
			}
		})
	}
}

func TestValidationMessage_CreateStatus(t *testing.T) {
	t.Parallel()
	v := makeValidator(t)

	cases := []struct {
		name string
		req  createSubscriptionReq
	}{
		{"missing status", createSubscriptionReq{AnilistID: 1, Status: ""}},
		{"invalid status", createSubscriptionReq{AnilistID: 1, Status: "nope"}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := runStructValidation(t, v, &tc.req)
			if err == nil {
				t.Fatalf("expected validation error, got nil")
			}
			got := validationMessage(err)
			if got != msgInvalidStatus {
				t.Errorf("validationMessage = %q, want %q", got, msgInvalidStatus)
			}
		})
	}
}

func TestValidationMessage_UpdateCurrentEpisode(t *testing.T) {
	t.Parallel()
	v := makeValidator(t)

	neg := int32(-1)
	req := updateSubscriptionReq{CurrentEpisode: &neg}
	err := runStructValidation(t, v, &req)
	if err == nil {
		t.Fatalf("expected validation error, got nil")
	}
	got := validationMessage(err)
	if got != msgInvalidEpisode {
		t.Errorf("validationMessage = %q, want %q", got, msgInvalidEpisode)
	}
}

func TestValidationMessage_UpdateStatus(t *testing.T) {
	t.Parallel()
	v := makeValidator(t)

	bad := "garbage"
	req := updateSubscriptionReq{Status: &bad}
	err := runStructValidation(t, v, &req)
	if err == nil {
		t.Fatalf("expected validation error, got nil")
	}
	got := validationMessage(err)
	if got != msgInvalidStatus {
		t.Errorf("validationMessage = %q, want %q", got, msgInvalidStatus)
	}
}

func TestValidationMessage_NonValidationError(t *testing.T) {
	t.Parallel()
	got := validationMessage(errors.New("not a validator error"))
	if got != msgInvalidRequestBody {
		t.Errorf("validationMessage on non-validator error = %q, want %q", got, msgInvalidRequestBody)
	}
}

func TestValidationMessage_UnknownField(t *testing.T) {
	t.Parallel()
	// Mock a "ValidationErrors" with no entries — defaults to msgInvalidRequestBody.
	verrs := validator.ValidationErrors{}
	got := validationMessage(verrs)
	if got != msgInvalidRequestBody {
		t.Errorf("validationMessage on empty errors = %q, want %q", got, msgInvalidRequestBody)
	}
}

// Successful validation should return nil — sanity-check the validator
// is wired correctly for the happy path.
func TestStructValidation_SuccessForValidPayload(t *testing.T) {
	t.Parallel()
	v := makeValidator(t)
	req := createSubscriptionReq{AnilistID: 42, Status: "watching"}
	if err := v.Struct(&req); err != nil {
		t.Fatalf("expected nil error for valid payload, got %v", err)
	}
}

// Update payload with all-nil fields must validate successfully — an
// empty PATCH is allowed.
func TestStructValidation_UpdateEmptyValid(t *testing.T) {
	t.Parallel()
	v := makeValidator(t)
	req := updateSubscriptionReq{}
	if err := v.Struct(&req); err != nil {
		t.Fatalf("expected nil error for empty update, got %v", err)
	}
}

// ----------------------------------------------------------------------------
// clampScore
// ----------------------------------------------------------------------------

func TestClampScore_NilInputProducesNil(t *testing.T) {
	t.Parallel()
	if got := clampScore(nil); got != nil {
		t.Errorf("clampScore(nil) = %v, want nil", got)
	}
}

func TestClampScore_LessThanOne(t *testing.T) {
	t.Parallel()
	in := int32(0)
	got := clampScore(&in)
	if got == nil || *got != 1 {
		t.Errorf("clampScore(0) = %v, want 1", got)
	}

	negative := int32(-5)
	got = clampScore(&negative)
	if got == nil || *got != 1 {
		t.Errorf("clampScore(-5) = %v, want 1", got)
	}
}

func TestClampScore_GreaterThanTen(t *testing.T) {
	t.Parallel()
	in := int32(15)
	got := clampScore(&in)
	if got == nil || *got != 10 {
		t.Errorf("clampScore(15) = %v, want 10", got)
	}
}

func TestClampScore_WithinRange(t *testing.T) {
	t.Parallel()
	for _, v := range []int32{1, 5, 10} {
		in := v
		got := clampScore(&in)
		if got == nil || *got != v {
			t.Errorf("clampScore(%d) = %v, want %d", v, got, v)
		}
	}
}
