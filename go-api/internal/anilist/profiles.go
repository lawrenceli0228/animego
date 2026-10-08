// profiles.go — AniList's profiles of people (Staff) and characters, read
// by id, fifty to a request.
//
// The one caller is the profiles sweep (queue/profiles.go), which stores
// them in the people and characters tables (migration 0044).  The two
// documents, their response shapes and the two client methods live in a
// file of their own because they are one feature, and client.go is
// already past the size the rest of this package keeps to.
package anilist

import (
	"context"
	"errors"
	"fmt"
	"net/http"
)

// MaxProfileIDs is the largest id batch a profile document carries:
// AniList's page maximum.  The documents spell it as the literal 50 in
// `Page(page: 1, perPage: 50)`, because a const string cannot be built
// from an int; TestProfileDocuments_BatchByID holds the two together.
//
// Past it AniList truncates without an error, and to the sweep an id that
// did not come back means "deleted upstream" -- so the cap is enforced
// here, on what is actually sent, as Ratings enforces MaxRatingIDs.
const MaxProfileIDs = 50

// ErrNoProfileIDs is returned for an empty batch.  Sending one would post
// `id_in: []`, which AniList reads as no filter at all (see
// ErrNoRatingIDs): the answer would be fifty arbitrary profiles, and every
// id the caller meant to ask about would look deleted.
var ErrNoProfileIDs = errors.New("anilist: profile batch has no ids")

// ErrProfileBatchTooLarge is returned for a batch past MaxProfileIDs.
var ErrProfileBatchTooLarge = errors.New("anilist: profile batch exceeds page cap")

// StaffProfilesQuery reads the profiles of up to MaxProfileIDs people by
// AniList Staff id: voice actors and production staff alike, since AniList
// keeps both as Staff.
//
// Variables:
//
//	$ids [Int]  AniList Staff ids, 1..MaxProfileIDs of them
//
// No pageInfo is selected.  Its total is not a figure AniList gets right,
// and with at most fifty ids on a page of fifty there is no next page to
// ask about: the answer is the page.  An id that is not in it is one
// AniList does not serve any more (deleted, or merged into another).
//
// description is AniList's own markdown (asHtml: false), spoiler markers
// (~!...!~) included; the sweep stores it as it comes.
const StaffProfilesQuery = `
  query StaffProfiles($ids: [Int]) {
    Page(page: 1, perPage: 50) {
      staff(id_in: $ids) {
        id
        name { full native alternative }
        languageV2
        image { large medium }
        description(asHtml: false)
        primaryOccupations
        gender
        dateOfBirth { year month day }
        dateOfDeath { year month day }
        age
        yearsActive
        homeTown
        bloodType
        favourites
        siteUrl
      }
    }
  }
`

// CharacterProfilesQuery is StaffProfilesQuery for AniList Character ids.
// alternativeSpoiler holds the names AniList hides as spoilers (a true
// identity, a later form); Character has no date of death, and its age is
// free text ("17", "16-17", "Unknown").
const CharacterProfilesQuery = `
  query CharacterProfiles($ids: [Int]) {
    Page(page: 1, perPage: 50) {
      characters(id_in: $ids) {
        id
        name { full native alternative alternativeSpoiler }
        image { large medium }
        description(asHtml: false)
        gender
        dateOfBirth { year month day }
        age
        bloodType
        favourites
        siteUrl
      }
    }
  }
`

// StaffName is the part of AniList's StaffName the sweep reads.  The list
// entries are pointers because AniList's [String] may carry nulls; what a
// null or a blank means is the normaliser's call (internal/profiles).
type StaffName struct {
	Full        *string   `json:"full"`
	Native      *string   `json:"native"`
	Alternative []*string `json:"alternative"`
}

// CharacterName is StaffName with the spoiler names.
type CharacterName struct {
	Full               *string   `json:"full"`
	Native             *string   `json:"native"`
	Alternative        []*string `json:"alternative"`
	AlternativeSpoiler []*string `json:"alternativeSpoiler"`
}

// StaffProfile is one person as StaffProfilesQuery reads them.  Every
// field but the id can be null on AniList and is a pointer here, so the
// decoder never turns "AniList does not say" into a zero.
//
// Age is AniList's own figure, computed from the date of birth on the day
// it is read.  YearsActive is positional: [first year] while active,
// [first, last] once not.
type StaffProfile struct {
	ID                 int        `json:"id"`
	Name               *StaffName `json:"name"`
	LanguageV2         *string    `json:"languageV2"`
	Image              *Image     `json:"image"`
	Description        *string    `json:"description"`
	PrimaryOccupations []*string  `json:"primaryOccupations"`
	Gender             *string    `json:"gender"`
	DateOfBirth        *FuzzyDate `json:"dateOfBirth"`
	DateOfDeath        *FuzzyDate `json:"dateOfDeath"`
	Age                *int       `json:"age"`
	YearsActive        []*int     `json:"yearsActive"`
	HomeTown           *string    `json:"homeTown"`
	BloodType          *string    `json:"bloodType"`
	Favourites         *int       `json:"favourites"`
	SiteURL            *string    `json:"siteUrl"`
}

// CharacterProfile is one character as CharacterProfilesQuery reads them.
type CharacterProfile struct {
	ID          int            `json:"id"`
	Name        *CharacterName `json:"name"`
	Image       *Image         `json:"image"`
	Description *string        `json:"description"`
	Gender      *string        `json:"gender"`
	DateOfBirth *FuzzyDate     `json:"dateOfBirth"`
	Age         *string        `json:"age"`
	BloodType   *string        `json:"bloodType"`
	Favourites  *int           `json:"favourites"`
	SiteURL     *string        `json:"siteUrl"`
}

// profileVars is the variable set both documents take.
type profileVars struct {
	IDs []int `json:"ids"`
}

// StaffProfilesNoWait reads the profiles of up to MaxProfileIDs people in
// one request, in the no-wait mode DetailNoWait uses: ErrBudgetBusy at
// once if the shared token bucket is empty, no 429 retry, never a sleep.
//
// No-wait is the only mode offered because the one caller is a background
// sweep, and a background request queued on the shared limiter is exactly
// how a cold detail request (a user or a crawler with nothing cached to
// fall back on) gets pushed past its deadline.  The caller spaces its
// attempts out; see queue/profiles.go.
//
// The result holds the profiles AniList returned, in AniList's order and
// possibly fewer than asked for: an id missing from it is one AniList no
// longer serves.  An answer with no list at all -- a null page, a null or
// absent list -- is an *ErrUpstream, never an empty result, because the
// caller records every missing id as deleted upstream.
func (c *Client) StaffProfilesNoWait(ctx context.Context, ids []int) ([]StaffProfile, error) {
	if err := checkProfileIDs(ids); err != nil {
		return nil, err
	}
	var dest struct {
		Page *struct {
			Staff []StaffProfile `json:"staff"`
		} `json:"Page"`
	}
	if err := c.doMode(ctx, StaffProfilesQuery, profileVars{IDs: ids}, &dest, false); err != nil {
		return nil, err
	}
	if dest.Page == nil || dest.Page.Staff == nil {
		return nil, errNoProfileList("staff")
	}
	return dest.Page.Staff, nil
}

// CharacterProfilesNoWait is StaffProfilesNoWait for AniList Character ids.
func (c *Client) CharacterProfilesNoWait(ctx context.Context, ids []int) ([]CharacterProfile, error) {
	if err := checkProfileIDs(ids); err != nil {
		return nil, err
	}
	var dest struct {
		Page *struct {
			Characters []CharacterProfile `json:"characters"`
		} `json:"Page"`
	}
	if err := c.doMode(ctx, CharacterProfilesQuery, profileVars{IDs: ids}, &dest, false); err != nil {
		return nil, err
	}
	if dest.Page == nil || dest.Page.Characters == nil {
		return nil, errNoProfileList("characters")
	}
	return dest.Page.Characters, nil
}

// checkProfileIDs refuses a batch no profile document can carry.  It runs
// before a token is taken, so a refused batch costs nothing.
func checkProfileIDs(ids []int) error {
	if len(ids) == 0 {
		return ErrNoProfileIDs
	}
	if len(ids) > MaxProfileIDs {
		return fmt.Errorf("%w: %d ids", ErrProfileBatchTooLarge, len(ids))
	}
	return nil
}

// errNoProfileList is the error for an answer that carries no list.
// encoding/json leaves a slice nil for a null or a missing key and makes
// it empty for `[]`, which is what tells the two apart.
func errNoProfileList(list string) error {
	return &ErrUpstream{Status: http.StatusBadGateway, Message: "AniList returned no " + list + " list"}
}
