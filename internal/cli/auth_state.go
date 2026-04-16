package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// AuthState is the CLI's cached credential for talking to a remote API. It
// lives at ~/.receiptd/auth.json (chmod 600) and is written by `receiptd
// login`, read by every command via the client's token resolution chain, and
// cleared by `receiptd logout`.
type AuthState struct {
	APIURL      string   `json:"api_url"`
	AccessToken string   `json:"access_token"`
	Subject     string   `json:"subject,omitempty"`
	Scopes      []string `json:"scopes,omitempty"`
}

// authStatePath returns ~/.receiptd/auth.json.
func authStatePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".receiptd", "auth.json"), nil
}

// LoadAuthState returns the cached state or nil if no file exists. Any read
// error other than "not found" is surfaced.
func LoadAuthState() (*AuthState, error) {
	path, err := authStatePath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read auth state: %w", err)
	}
	var s AuthState
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse auth state: %w", err)
	}
	return &s, nil
}

// SaveAuthState writes the state to ~/.receiptd/auth.json with 0600 perms.
func SaveAuthState(s *AuthState) error {
	path, err := authStatePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("mkdir auth dir: %w", err)
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	// Write via temp file + rename so a crash mid-write can't leave a
	// half-written credential file that future loads would reject.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ClearAuthState removes the file. Missing file is not an error.
func ClearAuthState() error {
	path, err := authStatePath()
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// ResolvedAPIURL returns the URL the CLI should use, preferring --api, then
// RECEIPTD_API, then a cached auth state. Empty string means local mode.
func ResolvedAPIURL() string {
	if apiURL != "" {
		return apiURL
	}
	if env := os.Getenv("RECEIPTD_API"); env != "" {
		return env
	}
	if s, _ := LoadAuthState(); s != nil {
		return s.APIURL
	}
	return ""
}

// ResolvedAPIKey returns the bearer token the CLI should send, preferring
// --api-key, then RECEIPTD_API_KEY, then a cached auth state.
func ResolvedAPIKey() string {
	if apiKey != "" {
		return apiKey
	}
	if env := os.Getenv("RECEIPTD_API_KEY"); env != "" {
		return env
	}
	if s, _ := LoadAuthState(); s != nil {
		return s.AccessToken
	}
	return ""
}
