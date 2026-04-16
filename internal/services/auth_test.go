package services

import (
	"context"
	"strings"
	"testing"

	"github.com/ChaseBro/receiptd/internal/db"
	"github.com/rs/zerolog"
)

func newTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	return database
}

func TestAPIKeys_MintAndVerifyRoundTrip(t *testing.T) {
	s := NewAPIKeys(newTestDB(t), "test", zerolog.Nop())
	ctx := context.Background()

	minted, err := s.Mint(ctx, MintInput{
		Subject: "user-1",
		Label:   "laptop",
		Scopes:  []string{"jobs:write", "render"},
	})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if !strings.HasPrefix(minted.Secret, "rd_test_") {
		t.Fatalf("bad secret prefix: %q", minted.Secret)
	}
	if minted.Key.ID != minted.Secret[:12] {
		t.Fatalf("ID %q != first 12 of secret %q", minted.Key.ID, minted.Secret[:12])
	}
	// Hash must not equal plaintext — DB must never store the secret itself.
	if strings.Contains(minted.Key.Hash, minted.Secret) {
		t.Fatal("hash column contains plaintext secret")
	}

	id, err := s.Verify(ctx, minted.Secret)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if id.Subject != "user-1" {
		t.Fatalf("Subject = %q", id.Subject)
	}
	if id.Kind != "apikey" {
		t.Fatalf("Kind = %q", id.Kind)
	}
	want := map[string]bool{"jobs:write": true, "render": true}
	for _, s := range id.Scopes {
		delete(want, s)
	}
	if len(want) != 0 {
		t.Fatalf("missing scopes: %v", want)
	}
}

func TestAPIKeys_VerifyRejectsUnknownAndRevoked(t *testing.T) {
	s := NewAPIKeys(newTestDB(t), "test", zerolog.Nop())
	ctx := context.Background()

	// Unknown token.
	if _, err := s.Verify(ctx, "rd_test_deadbeef1234"); err == nil {
		t.Fatal("unknown token should fail")
	}

	// Malformed token — fast-rejected without DB hit.
	if _, err := s.Verify(ctx, "not-a-receiptd-token"); err == nil {
		t.Fatal("malformed token should fail")
	}

	// Revoked token.
	minted, err := s.Mint(ctx, MintInput{Subject: "u", Scopes: []string{"jobs:write"}})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if err := s.Revoke(ctx, minted.Key.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := s.Verify(ctx, minted.Secret); err == nil {
		t.Fatal("revoked token should fail")
	}
}

func TestAPIKeys_ListBySubject(t *testing.T) {
	s := NewAPIKeys(newTestDB(t), "test", zerolog.Nop())
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, err := s.Mint(ctx, MintInput{Subject: "u1"}); err != nil {
			t.Fatalf("mint: %v", err)
		}
	}
	if _, err := s.Mint(ctx, MintInput{Subject: "u2"}); err != nil {
		t.Fatalf("mint: %v", err)
	}
	u1, err := s.List(ctx, "u1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(u1) != 3 {
		t.Fatalf("u1 has %d keys, want 3", len(u1))
	}
	u2, _ := s.List(ctx, "u2")
	if len(u2) != 1 {
		t.Fatalf("u2 has %d keys, want 1", len(u2))
	}
}

func TestAPIKeys_Mint_RequiresSubject(t *testing.T) {
	s := NewAPIKeys(newTestDB(t), "test", zerolog.Nop())
	if _, err := s.Mint(context.Background(), MintInput{}); err == nil {
		t.Fatal("expected error on missing subject")
	}
}
