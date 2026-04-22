package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var authCmd = &cobra.Command{
	Use:   "auth",
	Short: "Authentication: login, whoami, API key management",
}

var whoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "Show the identity the CLI is using (loopback, user, or API key)",
	Run: func(cmd *cobra.Command, args []string) {
		resp, err := httpGET("/v1/auth/whoami")
		if err != nil {
			ErrorExit(err.Error(), 1)
		}
		if jsonOutput {
			fmt.Println(string(resp))
			return
		}
		var body struct {
			Kind    string   `json:"kind"`
			Subject string   `json:"subject"`
			Scopes  []string `json:"scopes"`
		}
		if err := json.Unmarshal(resp, &body); err != nil {
			ErrorExit(fmt.Sprintf("parse whoami: %v", err), 1)
		}
		fmt.Printf("Kind:    %s\n", body.Kind)
		fmt.Printf("Subject: %s\n", body.Subject)
		if len(body.Scopes) > 0 {
			fmt.Printf("Scopes:  %v\n", body.Scopes)
		}
	},
}

var authKeysCmd = &cobra.Command{
	Use:   "keys",
	Short: "Manage API keys",
}

var authKeysListCmd = &cobra.Command{
	Use:   "list",
	Short: "List API keys for the current subject",
	Run: func(cmd *cobra.Command, args []string) {
		resp, err := httpGET("/v1/auth/keys")
		if err != nil {
			ErrorExit(err.Error(), 1)
		}
		if jsonOutput {
			fmt.Println(string(resp))
			return
		}
		var list []struct {
			ID        string   `json:"id"`
			Label     string   `json:"label,omitempty"`
			Scopes    []string `json:"scopes,omitempty"`
			Revoked   bool     `json:"revoked"`
			CreatedAt string   `json:"createdAt"`
		}
		if err := json.Unmarshal(resp, &list); err != nil {
			ErrorExit(fmt.Sprintf("parse keys: %v", err), 1)
		}
		if len(list) == 0 {
			fmt.Println("No API keys.")
			return
		}
		for _, k := range list {
			state := "active"
			if k.Revoked {
				state = "revoked"
			}
			fmt.Printf("%s  %-8s  %s  %v  %s\n", k.ID, state, k.CreatedAt, k.Scopes, k.Label)
		}
	},
}

var (
	keyCreateLabel  string
	keyCreateScopes []string
)

var authKeysCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Mint a new API key (plaintext shown once)",
	Run: func(cmd *cobra.Command, args []string) {
		body, _ := json.Marshal(map[string]interface{}{
			"label":  keyCreateLabel,
			"scopes": keyCreateScopes,
		})
		resp, err := httpPOST("/v1/auth/keys", body)
		if err != nil {
			ErrorExit(err.Error(), 1)
		}
		if jsonOutput {
			fmt.Println(string(resp))
			return
		}
		var out struct {
			ID     string   `json:"id"`
			Secret string   `json:"secret"`
			Label  string   `json:"label,omitempty"`
			Scopes []string `json:"scopes,omitempty"`
		}
		if err := json.Unmarshal(resp, &out); err != nil {
			ErrorExit(fmt.Sprintf("parse mint: %v", err), 1)
		}
		fmt.Printf("New API key (copy now — the secret will not be shown again):\n\n")
		fmt.Printf("  %s\n\n", out.Secret)
		fmt.Printf("ID:     %s\n", out.ID)
		if out.Label != "" {
			fmt.Printf("Label:  %s\n", out.Label)
		}
		if len(out.Scopes) > 0 {
			fmt.Printf("Scopes: %v\n", out.Scopes)
		}
	},
}

func init() {
	rootCmd.AddCommand(authCmd)
	authCmd.AddCommand(whoamiCmd)
	authCmd.AddCommand(loginCmd)
	authCmd.AddCommand(logoutCmd)
	authCmd.AddCommand(authKeysCmd)
	authKeysCmd.AddCommand(authKeysListCmd)
	authKeysCmd.AddCommand(authKeysCreateCmd)
	authKeysCmd.AddCommand(authKeysRevokeCmd)

	authKeysCreateCmd.Flags().StringVar(&keyCreateLabel, "label", "", "Human description, e.g. \"laptop agent\"")
	authKeysCreateCmd.Flags().StringSliceVar(&keyCreateScopes, "scope", []string{"jobs:write", "jobs:read", "render"}, "Scopes granted to this key")

	loginCmd.Flags().StringVar(&loginAPI, "api", "", "Remote receiptd API URL to log in to")

	// Top-level shortcuts: `receiptd whoami`, `receiptd login`, `receiptd logout`.
	rootCmd.AddCommand(&cobra.Command{Use: "whoami", Short: "Show the identity the CLI is using", Run: whoamiCmd.Run})
	rootCmd.AddCommand(&cobra.Command{Use: "login", Short: "Log in to a remote receiptd (device flow)", Run: loginCmd.Run})
	rootCmd.AddCommand(&cobra.Command{Use: "logout", Short: "Clear cached auth state", Run: logoutCmd.Run})
}

// httpGET / httpPOST are small helpers that honor --api / --api-key / cached
// auth state. They target either the remote API (when ResolvedAPIURL returns
// one) or the local daemon on http://127.0.0.1:3000. Raw response bytes are
// returned for the caller to decode.
func httpBase() string {
	if u := ResolvedAPIURL(); u != "" {
		return u
	}
	return "http://127.0.0.1:3000"
}

func httpKey() string {
	return ResolvedAPIKey()
}

func httpGET(path string) ([]byte, error) {
	return doHTTP(http.MethodGet, path, nil)
}

func httpPOST(path string, body []byte) ([]byte, error) {
	return doHTTP(http.MethodPost, path, body)
}

func doHTTP(method, path string, body []byte) ([]byte, error) {
	return doHTTPTo(httpBase(), method, path, body)
}

// doHTTPTo is doHTTP against an explicit base URL — used by `receiptd login`
// which needs to talk to a URL before the auth state has been written.
func doHTTPTo(base, method, path string, body []byte) ([]byte, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, base+path, r)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if k := httpKey(); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		var e struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		_ = json.Unmarshal(raw, &e)
		msg := e.Error
		if msg == "" {
			msg = string(raw)
		}
		// Include the machine-readable code so callers doing string-match on
		// the error (RFC 8628 poll loop watching for authorization_pending /
		// slow_down) work even when the human-readable message differs.
		if e.Code != "" {
			return nil, fmt.Errorf("%d %s [%s]: %s", resp.StatusCode, resp.Status, e.Code, msg)
		}
		return nil, fmt.Errorf("%d %s: %s", resp.StatusCode, resp.Status, msg)
	}
	return raw, nil
}

// --- login / logout / revoke -------------------------------------------

var loginAPI string

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Authenticate to a remote receiptd via OAuth 2.0 device flow",
	Long: `Starts a device-authorization flow (RFC 8628) against the given --api
URL. Prints a short user code and verification URL; once approved the CLI
caches the issued API key at ~/.receiptd/auth.json so future commands use it.`,
	Run: func(cmd *cobra.Command, args []string) {
		base := loginAPI
		if base == "" {
			base = apiURL
		}
		if base == "" {
			ErrorExit("--api required (or pass via `receiptd login --api https://…`)", 2)
		}
		// 1. Start the flow.
		raw, err := doHTTPTo(base, http.MethodPost, "/v1/auth/device/code", []byte(`{}`))
		if err != nil {
			ErrorExit(fmt.Sprintf("start device flow: %v", err), 1)
		}
		var start struct {
			DeviceCode              string `json:"device_code"`
			UserCode                string `json:"user_code"`
			VerificationURI         string `json:"verification_uri"`
			VerificationURIComplete string `json:"verification_uri_complete"`
			ExpiresIn               int    `json:"expires_in"`
			Interval                int    `json:"interval"`
		}
		if err := json.Unmarshal(raw, &start); err != nil {
			ErrorExit(fmt.Sprintf("parse device code response: %v", err), 1)
		}
		fmt.Printf("Visit: %s\n", start.VerificationURIComplete)
		fmt.Printf("Code:  %s\n", start.UserCode)
		fmt.Println("Waiting for approval…")

		// 2. Poll for the token. Gentle backoff on slow_down.
		interval := time.Duration(start.Interval) * time.Second
		if interval <= 0 {
			interval = 5 * time.Second
		}
		deadline := time.Now().Add(time.Duration(start.ExpiresIn) * time.Second)
		for time.Now().Before(deadline) {
			time.Sleep(interval)
			body, _ := json.Marshal(map[string]string{"device_code": start.DeviceCode})
			raw, err := doHTTPTo(base, http.MethodPost, "/v1/auth/device/token", body)
			if err != nil {
				lower := strings.ToLower(err.Error())
				switch {
				case strings.Contains(lower, "authorization_pending"):
					continue
				case strings.Contains(lower, "slow_down"):
					interval += 5 * time.Second
					continue
				case strings.Contains(lower, "expired_token"):
					ErrorExit("device code expired; run `receiptd login` again", 1)
				case strings.Contains(lower, "access_denied"):
					ErrorExit("approval denied", 1)
				default:
					ErrorExit(fmt.Sprintf("poll token: %v", err), 1)
				}
			}
			var tok struct {
				AccessToken string   `json:"access_token"`
				Subject     string   `json:"subject"`
				Scopes      []string `json:"scopes"`
			}
			if err := json.Unmarshal(raw, &tok); err != nil {
				ErrorExit(fmt.Sprintf("parse token: %v", err), 1)
			}
			if err := SaveAuthState(&AuthState{
				APIURL:      strings.TrimRight(base, "/"),
				AccessToken: tok.AccessToken,
				Subject:     tok.Subject,
				Scopes:      tok.Scopes,
			}); err != nil {
				ErrorExit(fmt.Sprintf("save auth state: %v", err), 1)
			}
			fmt.Printf("\n✓ Logged in as %s\n", tok.Subject)
			return
		}
		ErrorExit("timed out waiting for approval", 1)
	},
}

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Clear cached auth state (~/.receiptd/auth.json)",
	Run: func(cmd *cobra.Command, args []string) {
		if err := ClearAuthState(); err != nil {
			ErrorExit(fmt.Sprintf("clear: %v", err), 1)
		}
		fmt.Println("Logged out.")
	},
}

var authKeysRevokeCmd = &cobra.Command{
	Use:   "revoke <id>",
	Short: "Revoke an API key by its public prefix ID",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		path := "/v1/auth/keys/" + args[0]
		if _, err := doHTTP(http.MethodDelete, path, nil); err != nil {
			ErrorExit(err.Error(), 1)
		}
		fmt.Printf("Revoked %s\n", args[0])
	},
}
