// image_variant_warm_night.go — when the variant warm job runs, and what a
// night is to it: the window in Asia/Shanghai, the night's date, the
// refresh group the night takes, and the cursor that keeps the job's place
// in the night's list.  See image_variant_warm.go.
package queue

import (
	"hash/fnv"
	"io"
	"sync"
	"time"
)

// The window, as times of day in variantWarmZone.  A pass runs from
// variantWarmWindowOpen to variantWarmWindowClose, less the stretch from
// variantWarmBackupFrom to variantWarmBackupUntil, which the nightly
// database backup has.
const (
	variantWarmWindowOpen  = 1 * time.Hour
	variantWarmBackupFrom  = 3*time.Hour + 15*time.Minute
	variantWarmBackupUntil = 4 * time.Hour
	variantWarmWindowClose = 7 * time.Hour
)

// variantWarmZone is Asia/Shanghai as a fixed +08:00 offset.  China has kept
// no daylight saving since 1991, so the offset is that zone's answer for any
// night this job will see, and a fixed zone needs no tzdata in the image and
// cannot fail to load (activity.reportingZone makes the same choice).  The
// process itself runs in UTC; every time of day here is read in this zone.
var variantWarmZone = time.FixedZone("UTC+8", 8*60*60)

// refreshGroup is the refresh group of an image: every width of it is in
// the same one.  By its URL, so an image keeps its group however the list
// around it changes.
func refreshGroup(imageURL string) int {
	h := fnv.New32a()
	_, _ = io.WriteString(h, imageURL) // a hash.Hash never fails a write
	return int(h.Sum32() % imageVariantWarmGroups)
}

// variantWarmNight is the night a pass belongs to: its date in
// variantWarmZone, as days since the Unix epoch.  The window lies after
// midnight, so a night's passes all share the date.
func variantWarmNight(t time.Time) int64 {
	y, m, d := t.In(variantWarmZone).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix() / (24 * 60 * 60)
}

// tonightsGroup is the refresh group a night asks to be encoded again.
// Consecutive nights take consecutive groups, so 25 nights take every one.
func tonightsGroup(night int64) int {
	return int(night % imageVariantWarmGroups)
}

// variantWarmTimeOfDay is how long after midnight in variantWarmZone t is,
// and that midnight.
func variantWarmTimeOfDay(t time.Time) (time.Duration, time.Time) {
	local := t.In(variantWarmZone)
	y, m, d := local.Date()
	midnight := time.Date(y, m, d, 0, 0, 0, 0, variantWarmZone)
	return local.Sub(midnight), midnight
}

// inVariantWarmWindow reports whether a pass may ask at t.
func inVariantWarmWindow(t time.Time) bool {
	d, _ := variantWarmTimeOfDay(t)
	return d >= variantWarmWindowOpen && d < variantWarmWindowClose &&
		(d < variantWarmBackupFrom || d >= variantWarmBackupUntil)
}

// variantWarmWindowEnd is when the stretch of the window t is in closes:
// the backup's start for a time before it, the window's close for one
// after.  For a time outside the window, t itself.
func variantWarmWindowEnd(t time.Time) time.Time {
	if !inVariantWarmWindow(t) {
		return t
	}
	d, midnight := variantWarmTimeOfDay(t)
	if d < variantWarmBackupFrom {
		return midnight.Add(variantWarmBackupFrom)
	}
	return midnight.Add(variantWarmWindowClose)
}

// variantWarmCursor is how far down tonight's list the passes have got.
// One per process: see the file comment for why a restart starting again
// from the top is the right thing to lose.
type variantWarmCursor struct {
	mu sync.Mutex
	// night is the night the rest is about (variantWarmNight); 0, the
	// epoch's own date, is never one a pass runs on, so a cursor nobody
	// has saved is about no night.
	night int64
	next  int  // the position of the next variant to ask about
	done  bool // the whole list has been asked about tonight
}

// at is where tonight's next pass starts, and whether there is anything
// left: the top of the list on a night no pass has saved.
func (c *variantWarmCursor) at(night int64) (next int, done bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.night != night {
		return 0, false
	}
	return c.next, c.done
}

// save records where a pass stopped.
func (c *variantWarmCursor) save(night int64, next int, done bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.night, c.next, c.done = night, next, done
}
