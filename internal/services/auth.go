package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ChaseBro/receiptd/internal/db"
	"github.com/rs/zerolog"
)

// Identity is the authenticated principal. Mirrors server.Identity but is
// defined here to avoid an import cycle — services can't import server.
// Transports translate between the two as needed.
type Identity struct {
	Kind    string   // "apikey" | "user"
	Subject string   // user ID or key ID
	Scopes  []string // e.g. ["jobs:write", "render"]
}

// APIKeys is the service that mints and verifies API keys.
type APIKeys struct {
	db     *db.DB
	logger zerolog.Logger
	env    string // "live" | "test" — embedded in the key prefix
}

// NewAPIKeys builds an APIKeys service. env controls the prefix: rd_live_… or
// rd_test_… so you can tell real-from-dev keys apart at a glance.
func NewAPIKeys(database *db.DB, env string, logger zerolog.Logger) *APIKeys {
	if env == "" {
		env = "live"
	}
	return &APIKeys{
		db:     database,
		logger: logger.With().Str("component", "services.apikeys").Logger(),
		env:    env,
	}
}

// MintedKey is the once-returned envelope with the plaintext secret. After
// mint the plaintext is unrecoverable — only the prefix is kept in the DB.
type MintedKey struct {
	Secret string      // full token, shown once to the user
	Key    *db.APIKey  // persisted record (no plaintext)
}

// MintInput describes a new API key to create.
type MintInput struct {
	Subject string   // required: user ID
	Label   string   // optional description
	Scopes  []string // granted scopes
}

// ErrMissingSubject is returned when MintInput.Subject is empty.
var ErrMissingSubject = errors.New("subject required to mint api key")

// Mint generates a new API key, persists the hash+metadata, and returns the
// plaintext secret exactly once. Callers must show the secret to the user
// immediately and refuse to log it.
//
// Secret format: rd_<env>_<24 hex chars>.  Total length ~32.
// ID (public prefix): first 12 chars of the secret.
func (s *APIKeys) Mint(ctx context.Context, in MintInput) (*MintedKey, error) {
	if in.Subject == "" {
		return nil, ErrMissingSubject
	}
	// 12 random bytes → 24 hex chars.
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("rand: %w", err)
	}
	secret := fmt.Sprintf("rd_%s_%s", s.env, hex.EncodeToString(buf))
	prefix := secret[:12]
	hash := hashSecret(secret)

	rec := &db.APIKey{
		ID:        prefix,
		Hash:      hash,
		Subject:   in.Subject,
		Label:     in.Label,
		Scopes:    strings.Join(in.Scopes, " "),
		CreatedAt: time.Now(),
	}
	if err := s.db.CreateAPIKey(rec); err != nil {
		return nil, err
	}
	s.logger.Info().
		Str("subject", in.Subject).
		Str("prefix", prefix).
		Str("scopes", rec.Scopes).
		Msg("api key minted")
	return &MintedKey{Secret: secret, Key: rec}, nil
}

// Verify implements server.TokenVerifier. Looks up the bearer token's hash in
// the DB; returns an Identity when the key is present and unrevoked.
func (s *APIKeys) Verify(ctx context.Context, token string) (*Identity, error) {
	// Fast-reject malformed tokens without a DB hit.
	if !strings.HasPrefix(token, "rd_") {
		return nil, errors.New("invalid token format")
	}
	rec, err := s.db.GetAPIKeyByHash(hashSecret(token))
	if err != nil {
		return nil, err
	}
	if rec == nil {
		return nil, errors.New("unknown token")
	}
	if rec.RevokedAt != nil {
		return nil, errors.New("revoked token")
	}
	// Best-effort last-used update; don't block verification on it.
	_ = s.db.TouchAPIKey(rec.ID)

	return &Identity{
		Kind:    "apikey",
		Subject: rec.Subject,
		Scopes:  splitScopes(rec.Scopes),
	}, nil
}

// List returns all keys for a subject, newest first. Revoked keys are included
// so the caller can display them struck-through; filter client-side if needed.
func (s *APIKeys) List(ctx context.Context, subject string) ([]*db.APIKey, error) {
	return s.db.ListAPIKeys(subject)
}

// Revoke marks a key revoked.
func (s *APIKeys) Revoke(ctx context.Context, id string) error {
	return s.db.RevokeAPIKey(id)
}

func hashSecret(secret string) string {
	h := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(h[:])
}

func splitScopes(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Fields(s)
}
