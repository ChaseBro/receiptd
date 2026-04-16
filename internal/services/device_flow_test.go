package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func newDeviceFlow(t *testing.T) *DeviceFlow {
	t.Helper()
	database := newTestDB(t)
	keys := NewAPIKeys(database, "test", zerolog.Nop())
	return NewDeviceFlow(database, keys, "http://localhost/activate", zerolog.Nop())
}

func TestDeviceFlow_StartFormat(t *testing.T) {
	flow := newDeviceFlow(t)
	r, err := flow.Start(context.Background(), StartInput{Scopes: []string{"jobs:write"}})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !strings.HasPrefix(r.DeviceCode, "dc_") {
		t.Fatalf("DeviceCode prefix: %q", r.DeviceCode)
	}
	if len(r.UserCode) != 9 || r.UserCode[4] != '-' {
		t.Fatalf("UserCode shape: %q", r.UserCode)
	}
	if !strings.Contains(r.VerificationURIComplete, r.UserCode) {
		t.Fatalf("verification_uri_complete missing user_code: %q", r.VerificationURIComplete)
	}
	if r.ExpiresIn <= 0 {
		t.Fatalf("ExpiresIn: %d", r.ExpiresIn)
	}
}

func TestDeviceFlow_PollBeforeApprove(t *testing.T) {
	flow := newDeviceFlow(t)
	r, err := flow.Start(context.Background(), StartInput{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := flow.Poll(context.Background(), r.DeviceCode); !errors.Is(err, ErrAuthorizationPending) {
		t.Fatalf("Poll = %v, want ErrAuthorizationPending", err)
	}
}

func TestDeviceFlow_ApproveAndPollRoundTrip(t *testing.T) {
	flow := newDeviceFlow(t)
	ctx := context.Background()

	r, err := flow.Start(ctx, StartInput{Scopes: []string{"jobs:write"}})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Approve as the admin user.
	err = flow.Approve(ctx, ApproveInput{
		UserCode: r.UserCode,
		Subject:  "admin-user",
		Label:    "test",
	})
	if err != nil {
		t.Fatalf("Approve: %v", err)
	}

	// First poll: deliver the secret.
	result, err := flow.Poll(ctx, r.DeviceCode)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if !strings.HasPrefix(result.APIKey, "rd_test_") {
		t.Fatalf("APIKey: %q", result.APIKey)
	}
	if result.Subject != "admin-user" {
		t.Fatalf("Subject: %q", result.Subject)
	}
	if len(result.Scopes) != 1 || result.Scopes[0] != "jobs:write" {
		t.Fatalf("Scopes: %v", result.Scopes)
	}

	// Second poll: replay guard, secret cleared.
	if _, err := flow.Poll(ctx, r.DeviceCode); err == nil {
		t.Fatal("second poll should fail (secret cleared)")
	}

	// The minted key should verify.
	keys := flow.keys
	id, err := keys.Verify(ctx, result.APIKey)
	if err != nil {
		t.Fatalf("verify minted key: %v", err)
	}
	if id.Subject != "admin-user" {
		t.Fatalf("verified subject = %q", id.Subject)
	}
}

func TestDeviceFlow_DoubleApproveRejected(t *testing.T) {
	flow := newDeviceFlow(t)
	ctx := context.Background()
	r, _ := flow.Start(ctx, StartInput{})
	if err := flow.Approve(ctx, ApproveInput{UserCode: r.UserCode, Subject: "u"}); err != nil {
		t.Fatalf("first approve: %v", err)
	}
	if err := flow.Approve(ctx, ApproveInput{UserCode: r.UserCode, Subject: "u"}); err == nil {
		t.Fatal("second approve should fail")
	}
}

func TestDeviceFlow_UnknownCode(t *testing.T) {
	flow := newDeviceFlow(t)
	if _, err := flow.Poll(context.Background(), "dc_nope"); err == nil {
		t.Fatal("expected error for unknown device code")
	}
}
