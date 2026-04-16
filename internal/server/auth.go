package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"

	"github.com/rs/zerolog"
)

// Identity is the authenticated principal attached to an authorized request.
// Populated by AuthMiddleware and read by handlers via IdentityFromContext.
type Identity struct {
	Kind    string   // "user", "apikey", or "loopback"
	Subject string   // user ID or key ID
	Scopes  []string // e.g. ["jobs:write", "render"]
}

// HasScope reports whether the identity carries the named scope. The loopback
// identity always reports true — local callers bypass auth entirely.
func (id *Identity) HasScope(scope string) bool {
	if id == nil {
		return false
	}
	if id.Kind == "loopback" {
		return true
	}
	for _, s := range id.Scopes {
		if s == scope || s == "admin" {
			return true
		}
	}
	return false
}

// TokenVerifier resolves a bearer token or API key to an Identity.
// Implementations may hit a DB, a cache, or a static config.
type TokenVerifier interface {
	Verify(ctx context.Context, token string) (*Identity, error)
}

// noopVerifier rejects every token. Used as the default in local-only mode
// where the loopback bypass handles all real traffic.
type noopVerifier struct{}

func (noopVerifier) Verify(ctx context.Context, token string) (*Identity, error) {
	return nil, errInvalidToken
}

var errInvalidToken = &authError{code: "invalid_token", msg: "invalid or revoked token"}

type authError struct {
	code string
	msg  string
}

func (e *authError) Error() string { return e.msg }

// AuthConfig configures the middleware.
type AuthConfig struct {
	// Verifier checks tokens from non-loopback callers. Required in public mode;
	// may be nil in local-only mode (all non-loopback traffic is rejected).
	Verifier TokenVerifier

	// RequireAuthOnLoopback forces token auth even for 127.0.0.1/::1 requests.
	// Default false — preserves today's zero-friction local UX. Set true for
	// public deployments where even loopback could be attacker-controlled.
	RequireAuthOnLoopback bool

	Logger zerolog.Logger
}

type identityContextKey struct{}

// IdentityFromContext returns the Identity attached by AuthMiddleware, or nil
// if no identity was set (handler reached without auth, which AuthMiddleware
// prevents on protected routes).
func IdentityFromContext(ctx context.Context) *Identity {
	id, _ := ctx.Value(identityContextKey{}).(*Identity)
	return id
}

// AuthMiddleware validates bearer tokens on protected routes. Loopback callers
// get a synthetic Identity{Kind: "loopback", Scopes: ["admin"]} IFF they omit
// the Authorization header — preserving today's zero-friction local UX. When
// a loopback caller DOES send a bearer header it is validated normally, so
// a logged-in CLI exercises the real APIKeyVerifier path.
//
// RequireAuthOnLoopback disables the header-less bypass entirely — every
// request must present a valid token. Used by cloud deployments.
func AuthMiddleware(cfg AuthConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := extractBearer(r)

			// Loopback + no token = synthesize the local admin identity.
			if !cfg.RequireAuthOnLoopback && token == "" && isLoopback(r.RemoteAddr) {
				id := &Identity{Kind: "loopback", Subject: "local", Scopes: []string{"admin"}}
				r = r.WithContext(context.WithValue(r.Context(), identityContextKey{}, id))
				next.ServeHTTP(w, r)
				return
			}

			if token == "" {
				writeAuthError(w, http.StatusUnauthorized, "missing_token", "bearer token required")
				return
			}

			verifier := cfg.Verifier
			if verifier == nil {
				verifier = noopVerifier{}
			}
			id, err := verifier.Verify(r.Context(), token)
			if err != nil || id == nil {
				cfg.Logger.Info().Str("remote", r.RemoteAddr).Msg("auth: token rejected")
				writeAuthError(w, http.StatusUnauthorized, "invalid_token", "invalid or revoked token")
				return
			}

			r = r.WithContext(context.WithValue(r.Context(), identityContextKey{}, id))
			next.ServeHTTP(w, r)
		})
	}
}

// extractBearer pulls a token from the Authorization header.
// Supports both "Bearer <token>" and raw-token forms.
func extractBearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	const prefix = "Bearer "
	if strings.HasPrefix(h, prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return strings.TrimSpace(h)
}

// isLoopback reports whether remoteAddr is a loopback address.
// r.RemoteAddr looks like "127.0.0.1:54321" or "[::1]:54321".
func isLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return host == "localhost"
	}
	return ip.IsLoopback()
}

func writeAuthError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("WWW-Authenticate", "Bearer")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg, "code": code})
}
