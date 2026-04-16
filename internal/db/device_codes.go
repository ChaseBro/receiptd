package db

import (
	"database/sql"
	"fmt"
	"time"
)

// DeviceCode tracks a single in-flight RFC 8628 device-authorization flow.
// Only the hash of the opaque device_code is stored, never the plaintext.
type DeviceCode struct {
	DeviceCodeHash  string
	UserCode        string
	Subject         string
	Scopes          string
	ExpiresAt       time.Time
	IntervalSeconds int
	ApprovedAt      *time.Time
	IssuedSecret    string // plaintext API key returned once, then cleared
	CreatedAt       time.Time
}

// Approved reports whether the code has been marked approved.
func (c *DeviceCode) Approved() bool { return c.ApprovedAt != nil }

// Expired reports whether the code is past its expiry.
func (c *DeviceCode) Expired() bool { return time.Now().After(c.ExpiresAt) }

// CreateDeviceCode persists a new pending device-flow entry.
func (d *DB) CreateDeviceCode(c *DeviceCode) error {
	_, err := d.Exec(`
		INSERT INTO device_codes (device_code_hash, user_code, scopes, expires_at,
		                          interval_seconds, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		c.DeviceCodeHash, c.UserCode, c.Scopes,
		c.ExpiresAt.UTC().Format(time.RFC3339Nano),
		c.IntervalSeconds,
		c.CreatedAt.UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		return fmt.Errorf("create device code: %w", err)
	}
	return nil
}

// GetDeviceCodeByHash fetches a code by its hash. Returns nil, nil on miss.
func (d *DB) GetDeviceCodeByHash(hash string) (*DeviceCode, error) {
	row := d.QueryRow(`
		SELECT device_code_hash, user_code, subject, scopes, expires_at,
		       interval_seconds, approved_at, issued_secret, created_at
		FROM device_codes WHERE device_code_hash = ?`, hash)
	c, err := scanDeviceCode(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return c, err
}

// GetDeviceCodeByUserCode fetches a code by its user-facing code. Returns nil, nil on miss.
func (d *DB) GetDeviceCodeByUserCode(userCode string) (*DeviceCode, error) {
	row := d.QueryRow(`
		SELECT device_code_hash, user_code, subject, scopes, expires_at,
		       interval_seconds, approved_at, issued_secret, created_at
		FROM device_codes WHERE user_code = ?`, userCode)
	c, err := scanDeviceCode(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return c, err
}

// ApproveDeviceCode marks the code approved and stores the issued api-key
// secret so the next poll can return it. The secret is cleared on first read.
func (d *DB) ApproveDeviceCode(userCode, subject, scopes, secret string) error {
	res, err := d.Exec(`
		UPDATE device_codes SET
		    subject       = ?,
		    scopes        = ?,
		    approved_at   = ?,
		    issued_secret = ?
		WHERE user_code = ? AND approved_at IS NULL`,
		subject, scopes,
		time.Now().UTC().Format(time.RFC3339Nano),
		secret,
		userCode,
	)
	if err != nil {
		return fmt.Errorf("approve device code: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("user_code not found or already approved")
	}
	return nil
}

// ClearDeviceCodeSecret blanks the one-shot issued_secret after it has been
// delivered to the polling CLI. Keeps the approval record for audit.
func (d *DB) ClearDeviceCodeSecret(hash string) error {
	_, err := d.Exec(`UPDATE device_codes SET issued_secret = '' WHERE device_code_hash = ?`, hash)
	return err
}

// PruneExpiredDeviceCodes deletes codes past expiry. Call periodically.
func (d *DB) PruneExpiredDeviceCodes() error {
	_, err := d.Exec(`DELETE FROM device_codes WHERE expires_at < ?`,
		time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func scanDeviceCode(row rowScanner) (*DeviceCode, error) {
	var c DeviceCode
	var subject, scopes, approvedAt, issued sql.NullString
	var expiresAt, createdAt sql.NullString
	err := row.Scan(
		&c.DeviceCodeHash, &c.UserCode, &subject, &scopes,
		&expiresAt, &c.IntervalSeconds, &approvedAt, &issued, &createdAt,
	)
	if err != nil {
		return nil, err
	}
	c.Subject = subject.String
	c.Scopes = scopes.String
	c.IssuedSecret = issued.String
	if t, err := time.Parse(time.RFC3339Nano, expiresAt.String); err == nil {
		c.ExpiresAt = t
	}
	if t, err := time.Parse(time.RFC3339Nano, createdAt.String); err == nil {
		c.CreatedAt = t
	}
	c.ApprovedAt = parseNullTime(approvedAt)
	return &c, nil
}
