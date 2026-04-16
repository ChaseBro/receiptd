package server

import (
	"context"

	"github.com/ChaseBro/receiptd/internal/services"
)

// APIKeyVerifier adapts a services.APIKeys to the server.TokenVerifier
// interface. Kept here (not in services) so the services package doesn't have
// to depend on server types.
type APIKeyVerifier struct {
	keys *services.APIKeys
}

// NewAPIKeyVerifier builds the adapter.
func NewAPIKeyVerifier(keys *services.APIKeys) *APIKeyVerifier {
	return &APIKeyVerifier{keys: keys}
}

// Verify delegates to the APIKeys service and translates its Identity into the
// server-side type.
func (v *APIKeyVerifier) Verify(ctx context.Context, token string) (*Identity, error) {
	sid, err := v.keys.Verify(ctx, token)
	if err != nil {
		return nil, err
	}
	return &Identity{
		Kind:    sid.Kind,
		Subject: sid.Subject,
		Scopes:  sid.Scopes,
	}, nil
}
