package db

import (
	"database/sql"
	"fmt"
	"time"
)

// APIKey is a persisted API key record. The plaintext secret is never stored;
// only a SHA-256 hash of the full `rd_*_...` string is kept in Hash. The ID
// column holds the public prefix (first 12 chars of the secret) which is safe
// to log and display.
type APIKey struct {
	ID         string // public prefix, e.g. "rd_live_a1b2"
	Hash       string // hex-encoded SHA-256 of the full secret
	Subject    string // user ID this key belongs to
	Label      string // human description, e.g. "laptop agent"
	Scopes     string // space-separated scope list, e.g. "jobs:write render"
	CreatedAt  time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
}

// CreateAPIKey inserts a new key. The caller must have already hashed the
// secret and generated the prefix ID.
func (d *DB) CreateAPIKey(k *APIKey) error {
	_, err := d.Exec(`
		INSERT INTO api_keys (id, hash, subject, label, scopes, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		k.ID, k.Hash, k.Subject, k.Label, k.Scopes,
		k.CreatedAt.UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		return fmt.Errorf("create api key: %w", err)
	}
	return nil
}

// GetAPIKeyByHash looks up a key by hash. Returns nil, nil when not found.
// Revoked keys are returned with RevokedAt set — callers must check.
func (d *DB) GetAPIKeyByHash(hash string) (*APIKey, error) {
	row := d.QueryRow(`
		SELECT id, hash, subject, label, scopes, created_at, last_used_at, revoked_at
		FROM api_keys WHERE hash = ?`, hash)
	k, err := scanAPIKey(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return k, err
}

// TouchAPIKey updates last_used_at to now. Best-effort — caller ignores error.
func (d *DB) TouchAPIKey(id string) error {
	_, err := d.Exec(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`,
		time.Now().UTC().Format(time.RFC3339Nano), id)
	return err
}

// ListAPIKeys returns all keys for a subject, newest first.
func (d *DB) ListAPIKeys(subject string) ([]*APIKey, error) {
	rows, err := d.Query(`
		SELECT id, hash, subject, label, scopes, created_at, last_used_at, revoked_at
		FROM api_keys WHERE subject = ? ORDER BY created_at DESC`, subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var keys []*APIKey
	for rows.Next() {
		k, err := scanAPIKey(rows)
		if err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

// RevokeAPIKey marks a key revoked. Idempotent.
func (d *DB) RevokeAPIKey(id string) error {
	_, err := d.Exec(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
		time.Now().UTC().Format(time.RFC3339Nano), id)
	return err
}

func scanAPIKey(row rowScanner) (*APIKey, error) {
	var k APIKey
	var label, scopes, createdAt sql.NullString
	var lastUsedAt, revokedAt sql.NullString
	err := row.Scan(&k.ID, &k.Hash, &k.Subject, &label, &scopes, &createdAt, &lastUsedAt, &revokedAt)
	if err != nil {
		return nil, err
	}
	k.Label = label.String
	k.Scopes = scopes.String
	if t, err := time.Parse(time.RFC3339Nano, createdAt.String); err == nil {
		k.CreatedAt = t
	}
	k.LastUsedAt = parseNullTime(lastUsedAt)
	k.RevokedAt = parseNullTime(revokedAt)
	return &k, nil
}
