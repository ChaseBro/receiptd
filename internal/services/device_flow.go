package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ChaseBro/receiptd/internal/db"
	"github.com/rs/zerolog"
)

// DeviceFlow implements the server side of the OAuth 2.0 Device Authorization
// Grant (RFC 8628). The CLI asks for a code, prints a URL + short user_code,
// and polls the token endpoint until a human approves on the auth server.
// On approval the flow mints an API key and returns its plaintext exactly once.
type DeviceFlow struct {
	db      *db.DB
	keys    *APIKeys
	logger  zerolog.Logger
	baseURL string // verification URL shown to the user, e.g. https://receiptd.sh/activate
}

// NewDeviceFlow builds a DeviceFlow service.
func NewDeviceFlow(database *db.DB, keys *APIKeys, verificationBaseURL string, logger zerolog.Logger) *DeviceFlow {
	if verificationBaseURL == "" {
		verificationBaseURL = "http://localhost:3000/activate"
	}
	return &DeviceFlow{
		db:      database,
		keys:    keys,
		logger:  logger.With().Str("component", "services.deviceflow").Logger(),
		baseURL: verificationBaseURL,
	}
}

// StartInput requests a new device flow.
type StartInput struct {
	Scopes []string
}

// StartResult is the response to POST /v1/auth/device/code.
type StartResult struct {
	DeviceCode      string // opaque secret, polled by CLI
	UserCode        string // short human code shown to user
	VerificationURI string // where the human should go
	VerificationURIComplete string // URI pre-filled with user_code
	ExpiresIn       int    // seconds
	Interval        int    // polling interval
}

// Start creates a new device-code entry. Device codes live for 10 minutes and
// the suggested polling interval is 5 seconds.
func (s *DeviceFlow) Start(ctx context.Context, in StartInput) (*StartResult, error) {
	const expiresIn = 10 * time.Minute
	const interval = 5

	deviceCode, err := randomDeviceCode()
	if err != nil {
		return nil, err
	}
	userCode, err := randomUserCode()
	if err != nil {
		return nil, err
	}

	rec := &db.DeviceCode{
		DeviceCodeHash:  hashSecret(deviceCode),
		UserCode:        userCode,
		Scopes:          strings.Join(in.Scopes, " "),
		ExpiresAt:       time.Now().Add(expiresIn),
		IntervalSeconds: interval,
		CreatedAt:       time.Now(),
	}
	if err := s.db.CreateDeviceCode(rec); err != nil {
		return nil, err
	}
	s.logger.Info().Str("user_code", userCode).Msg("device flow started")

	return &StartResult{
		DeviceCode:              deviceCode,
		UserCode:                userCode,
		VerificationURI:         s.baseURL,
		VerificationURIComplete: fmt.Sprintf("%s?code=%s", s.baseURL, userCode),
		ExpiresIn:               int(expiresIn / time.Second),
		Interval:                interval,
	}, nil
}

// Errors returned by Poll. These mirror the RFC 8628 token-endpoint error
// codes so clients can distinguish "keep polling" from terminal failures.
var (
	ErrAuthorizationPending = errors.New("authorization_pending")
	ErrSlowDown             = errors.New("slow_down")
	ErrExpiredToken         = errors.New("expired_token")
	ErrAccessDenied         = errors.New("access_denied")
	ErrBadDeviceCode        = errors.New("invalid_grant")
)

// PollResult is what the CLI receives once the flow is approved.
type PollResult struct {
	APIKey  string   // plaintext secret (shown once; caller must cache or display)
	Subject string
	Scopes  []string
}

// Poll is called by the CLI to check whether a device code has been approved.
// Returns ErrAuthorizationPending while waiting, the minted API key once
// approved, or a terminal error (expired, denied, bad code).
func (s *DeviceFlow) Poll(ctx context.Context, deviceCode string) (*PollResult, error) {
	rec, err := s.db.GetDeviceCodeByHash(hashSecret(deviceCode))
	if err != nil {
		return nil, err
	}
	if rec == nil {
		return nil, ErrBadDeviceCode
	}
	if rec.Expired() {
		return nil, ErrExpiredToken
	}
	if !rec.Approved() {
		return nil, ErrAuthorizationPending
	}
	if rec.IssuedSecret == "" {
		// Already delivered once — replay guard.
		return nil, ErrBadDeviceCode
	}
	secret := rec.IssuedSecret
	_ = s.db.ClearDeviceCodeSecret(rec.DeviceCodeHash)
	return &PollResult{
		APIKey:  secret,
		Subject: rec.Subject,
		Scopes:  splitScopes(rec.Scopes),
	}, nil
}

// ApproveInput is the caller-supplied identity + optional scope override that
// will be baked into the minted API key.
type ApproveInput struct {
	UserCode string
	Subject  string   // who's approving (taken from Identity of the approving caller)
	Scopes   []string // scopes to grant; if empty, the scopes the flow started with are kept
	Label    string
}

// Approve completes a pending device flow and mints an API key for it.
// The approving caller is trusted to have authenticated themselves via
// normal auth middleware (admin scope in today's model).
func (s *DeviceFlow) Approve(ctx context.Context, in ApproveInput) error {
	rec, err := s.db.GetDeviceCodeByUserCode(in.UserCode)
	if err != nil {
		return err
	}
	if rec == nil {
		return fmt.Errorf("unknown user_code")
	}
	if rec.Expired() {
		return ErrExpiredToken
	}
	if rec.Approved() {
		return fmt.Errorf("already approved")
	}
	scopes := in.Scopes
	if len(scopes) == 0 {
		scopes = splitScopes(rec.Scopes)
	}
	label := in.Label
	if label == "" {
		label = "device:" + in.UserCode
	}
	minted, err := s.keys.Mint(ctx, MintInput{
		Subject: in.Subject,
		Label:   label,
		Scopes:  scopes,
	})
	if err != nil {
		return err
	}
	if err := s.db.ApproveDeviceCode(in.UserCode, in.Subject, strings.Join(scopes, " "), minted.Secret); err != nil {
		return err
	}
	s.logger.Info().
		Str("user_code", in.UserCode).
		Str("subject", in.Subject).
		Msg("device flow approved")
	return nil
}

func randomDeviceCode() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "dc_" + hex.EncodeToString(buf), nil
}

// randomUserCode returns a user-enterable short code, e.g. "WXYZ-1234".
// Alphabet excludes visually ambiguous chars (0/O, 1/I/L).
func randomUserCode() (string, error) {
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, 9)
	for i, b := range buf {
		out[i] = alphabet[int(b)%len(alphabet)]
		if i == 3 {
			out[i+1] = '-'
		}
	}
	// Adjust layout: positions 0-3 letters, 4 is dash, 5-8 letters
	return string(out[:4]) + "-" + string(out[4:8]), nil
}
