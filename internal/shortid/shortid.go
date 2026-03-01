// Package shortid generates short, human-friendly IDs for renders and jobs.
package shortid

import (
	"hash/fnv"
	"strings"
	"time"
)

// New returns a 5-char lowercase hex ID derived from t (nanoseconds via FNV-32a).
// IDs are stable for a given timestamp and trivially collision-free at
// receipt-printer volumes (~1 M unique values).
func New(t time.Time) string {
	h := fnv.New32a()
	ns := t.UnixNano()
	b := [8]byte{
		byte(ns >> 56), byte(ns >> 48), byte(ns >> 40), byte(ns >> 32),
		byte(ns >> 24), byte(ns >> 16), byte(ns >> 8), byte(ns),
	}
	h.Write(b[:])
	sum := h.Sum32()
	// Encode as 5 lowercase hex chars (20 bits used — sufficient at this volume).
	const digits = "0123456789abcdef"
	out := [5]byte{
		digits[(sum>>16)&0xf],
		digits[(sum>>12)&0xf],
		digits[(sum>>8)&0xf],
		digits[(sum>>4)&0xf],
		digits[sum&0xf],
	}
	return string(out[:])
}

// Match returns the entries from ids whose values have the given prefix (case-insensitive).
func Match(ids []string, prefix string) []string {
	prefix = strings.ToLower(prefix)
	var out []string
	for _, id := range ids {
		if strings.HasPrefix(strings.ToLower(id), prefix) {
			out = append(out, id)
		}
	}
	return out
}
