package auth

// account.go — self-serve account mutation for a logged-in user:
//   PATCH /api/auth/me → UpdateMe (username / avatar / backdrop)
//
// Requires RequireAuth (the user id comes from the JWT claims, never the
// body). UpdateMe applies any subset of the three personalization fields;
// avatarUrl "" clears the photo and backdropAnilistId 0 clears the backdrop.
//
// Password changes deliberately do NOT have a self-serve endpoint: they go
// through the email-based forgot-password / reset flow, which proves email
// ownership and so survives a hijacked session.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/lawrenceli0228/animego/go-api/internal/avatars"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

const (
	msgAvatarTooLarge = "Photo is too large"
	maxAvatarChars    = 900_000 // data-URL length cap (~650KB JPEG)
	minUsernameLen    = 3
	maxUsernameLen    = 50
)

type updateMeReq struct {
	Username          *string `json:"username"`
	AvatarURL         *string `json:"avatarUrl"`
	BackdropAnilistID *int32  `json:"backdropAnilistId"`
}

// UpdateMe implements PATCH /api/auth/me.
func (h *Handlers) UpdateMe(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, codeServerError, "missing auth claims"))
		return
	}

	var req updateMeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgInvalidBody))
		return
	}

	if req.Username != nil {
		name := strings.TrimSpace(*req.Username)
		if len(name) < minUsernameLen || len(name) > maxUsernameLen {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgUsernameLen))
			return
		}
		if _, err := h.db.UpdateUsername(ctx, claims.UserID, name); err != nil {
			if isUniqueViolation(err) {
				httpx.Fail(w, httpx.NewError(http.StatusConflict, codeDuplicate, msgDuplicate))
				return
			}
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "update username failed"))
			return
		}
	}

	if req.AvatarURL != nil {
		val := strings.TrimSpace(*req.AvatarURL)
		if len(val) > maxAvatarChars {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgAvatarTooLarge))
			return
		}
		var avatar *string // nil = clear
		switch {
		case val == "":
			// clear: drop the stored file too
			avatars.Delete(h.avatarDir, claims.UserID.String())
		case strings.HasPrefix(val, "data:"):
			// uploaded photo: write to the volume, store the short URL
			url, err := avatars.Save(h.avatarDir, claims.UserID.String(), val)
			if err != nil {
				if avatars.IsBadImage(err) {
					httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgAvatarTooLarge))
				} else {
					httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "save avatar failed"))
				}
				return
			}
			avatar = &url
		default:
			// already a URL (back-compat, e.g. an external cover) → store as-is
			avatar = &val
		}
		if err := h.db.SetUserAvatar(ctx, claims.UserID, avatar); err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "update avatar failed"))
			return
		}
	}

	if req.BackdropAnilistID != nil {
		var backdrop *int32 // nil = clear
		if *req.BackdropAnilistID > 0 {
			v := *req.BackdropAnilistID
			backdrop = &v
		}
		if err := h.db.SetUserBackdrop(ctx, claims.UserID, backdrop); err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "update backdrop failed"))
			return
		}
	}

	user, err := h.db.GetUserByID(ctx, claims.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, codeNotFound, msgUserNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "user lookup failed"))
		return
	}
	httpx.Data(w, http.StatusOK, MeData{User: h.fillBackdropImages(ctx, ToSafeUser(user))})
}

// fillBackdropImages resolves the chosen backdrop anime (if any) into the
// banner + cover URLs on the SafeUser. Best-effort: an uncached anime (no
// row) just leaves the fields nil, so the avatar falls back to the photo.
func (h *Handlers) fillBackdropImages(ctx context.Context, su SafeUser) SafeUser {
	if su.BackdropAnilistID == nil {
		return su
	}
	imgs, err := h.db.GetAnimeImages(ctx, *su.BackdropAnilistID)
	if err != nil {
		return su
	}
	su.BackdropBannerURL = imgs.BannerImageUrl
	su.BackdropCoverURL = imgs.CoverImageUrl
	return su
}
