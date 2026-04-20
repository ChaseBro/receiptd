// Package printerconfig provisions a Star TSP100IV printer's CloudPRNT
// settings over the LAN by driving its web UI directly. The web UI is a
// plain cookie-gated CGI form (no CSRF, no JS-only widgets), so net/http
// handles the whole flow in ~50 lines.
//
// Flow:
//  1. POST /auth/form_authentication.cgi  (username=root&password=...)
//     → Set-Cookie: form_authentication_key=<sha1>
//  2. POST /html/cloudprnt_cgi            (the settings form)
//  3. POST /html/save_cgi                 (radio_sv=r_save_res → save + restart)
//
// Probed against firmware HI01x on 192.168.1.38 on 2026-04-20. If Star ever
// changes the form names, callers can fall back to the pasteable block
// emitted by the CLI.
package printerconfig

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Default admin user on TSP100IV — not configurable from the web UI.
const DefaultAdminUser = "root"

// Credentials describes how to reach the printer's admin UI.
type Credentials struct {
	// Host is the printer's LAN address. "192.168.1.38", "printer.local",
	// or a full base URL — a scheme is added if missing.
	Host      string
	AdminUser string // defaults to DefaultAdminUser
	AdminPass string
}

// CloudPRNTSettings mirrors the TSP100IV cloudprnt.htm form fields. Leave
// HTTPTimeoutSec at zero to keep the printer's existing choice (the form
// re-submits what the user saw).
type CloudPRNTSettings struct {
	Enable         bool
	ServerURL      string
	PollingSec     int    // 1-7200; 0 means keep default 5
	HTTPTimeoutSec int    // one of 10/20/30/40/50/60; 0 keeps default 60
	Username       string // max 63 — HTTP Basic user the printer presents
	Password       string // max 63
}

// Session is an authenticated cookie-backed HTTP session against one
// printer. Safe to reuse across multiple CGI calls; not safe for concurrent
// use.
type Session struct {
	base   string
	http   *http.Client
	logger func(string, ...any)
}

// Dial logs into the printer and returns an authenticated session. The
// printer issues a `form_authentication_key` cookie on successful login;
// all subsequent requests carry it through the cookie jar.
func Dial(ctx context.Context, creds Credentials) (*Session, error) {
	base, err := normalizeHost(creds.Host)
	if err != nil {
		return nil, err
	}
	user := creds.AdminUser
	if user == "" {
		user = DefaultAdminUser
	}
	if creds.AdminPass == "" {
		return nil, fmt.Errorf("printerconfig: admin password required")
	}

	jar, _ := cookiejar.New(nil)
	s := &Session{
		base: base,
		http: &http.Client{
			Jar:     jar,
			Timeout: 15 * time.Second,
			// Login returns 303; we want to capture the cookie without
			// following into /index.htm which we don't need.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}

	form := url.Values{"username": {user}, "password": {creds.AdminPass}}
	resp, err := s.post(ctx, "/auth/form_authentication.cgi", form, nil)
	if err != nil {
		return nil, fmt.Errorf("login: %w", err)
	}
	defer resp.Body.Close()

	// Success = 303 See Other with Set-Cookie. On bad credentials the CGI
	// returns 200 with the login form re-rendered (no cookie).
	if resp.StatusCode != http.StatusSeeOther {
		return nil, fmt.Errorf("login: unexpected status %s (wrong admin password?)", resp.Status)
	}
	if !sessionCookieSet(s.http.Jar, base) {
		return nil, fmt.Errorf("login: no session cookie returned — credentials likely wrong")
	}
	return s, nil
}

// ApplyCloudPRNT submits the CloudPRNT settings form. Returns a non-nil
// error if the CGI replies with a non-2xx response; the printer will reply
// 200 regardless of validation so this is mostly a transport-level check.
func (s *Session) ApplyCloudPRNT(ctx context.Context, cfg CloudPRNTSettings) error {
	if cfg.ServerURL == "" {
		return fmt.Errorf("printerconfig: ServerURL required")
	}
	if len(cfg.Username) > 63 || len(cfg.Password) > 63 {
		return fmt.Errorf("printerconfig: Username/Password must be ≤63 chars (printer limit)")
	}
	if len(cfg.ServerURL) > 511 {
		return fmt.Errorf("printerconfig: ServerURL must be ≤511 chars")
	}

	polling := cfg.PollingSec
	if polling <= 0 {
		polling = 5
	}
	timeout := cfg.HTTPTimeoutSec
	if timeout <= 0 {
		timeout = 60
	}

	enable := "DISABLE"
	if cfg.Enable {
		enable = "ENABLE"
	}

	form := url.Values{
		"cloudprnt_enable_selection": {enable},
		"server_url":                 {cfg.ServerURL},
		"polling_time":               {strconv.Itoa(polling)},
		"http_response_timeout":      {strconv.Itoa(timeout)},
		"user_name":                  {cfg.Username},
		"cp_password":                {cfg.Password},
		"Submit":                     {"submit"},
	}
	resp, err := s.post(ctx, "/html/cloudprnt_cgi", form, nil)
	if err != nil {
		return fmt.Errorf("apply cloudprnt: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("apply cloudprnt: %s: %s", resp.Status, strings.TrimSpace(string(snippet)))
	}
	return nil
}

// SaveAndRestart commits pending settings to flash and reboots the printer.
// The device drops the session immediately; callers should not reuse the
// Session after this call.
func (s *Session) SaveAndRestart(ctx context.Context) error {
	form := url.Values{
		"radio_sv": {"r_save_res"}, // "Save → Restart device" (skips config-print)
		"valid_sv": {"sv_send_ok"},
	}
	resp, err := s.post(ctx, "/html/save_cgi", form, nil)
	if err != nil {
		// Printer often kills the TCP connection mid-response when it
		// reboots — treat broken-pipe/EOF as success.
		if isRebootTearDown(err) {
			return nil
		}
		return fmt.Errorf("save+restart: %w", err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return nil
}

// Close releases any HTTP connections. After SaveAndRestart the session is
// invalid regardless; Close is optional.
func (s *Session) Close() {
	s.http.CloseIdleConnections()
}

func (s *Session) post(ctx context.Context, path string, form url.Values, hdrs http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.base+path, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for k, v := range hdrs {
		req.Header[k] = v
	}
	return s.http.Do(req)
}

// normalizeHost accepts "192.168.1.38", "printer.local:80", or a full URL
// and returns a canonical "scheme://host" base for all endpoints.
func normalizeHost(host string) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return "", fmt.Errorf("printerconfig: host required")
	}
	if !strings.Contains(host, "://") {
		host = "http://" + host
	}
	u, err := url.Parse(host)
	if err != nil {
		return "", fmt.Errorf("printerconfig: bad host %q: %w", host, err)
	}
	if u.Host == "" {
		return "", fmt.Errorf("printerconfig: bad host %q", host)
	}
	return strings.TrimRight(u.Scheme+"://"+u.Host, "/"), nil
}

func sessionCookieSet(jar http.CookieJar, base string) bool {
	u, err := url.Parse(base)
	if err != nil {
		return false
	}
	for _, c := range jar.Cookies(u) {
		if c.Name == "form_authentication_key" && c.Value != "" {
			return true
		}
	}
	return false
}

func isRebootTearDown(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "EOF") ||
		strings.Contains(msg, "broken pipe") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "connection refused")
}
