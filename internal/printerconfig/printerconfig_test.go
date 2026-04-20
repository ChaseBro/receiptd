package printerconfig

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakePrinter is a minimal stand-in for the TSP100IV web UI's three CGI
// endpoints. It captures posted form data for assertions.
type fakePrinter struct {
	server        *httptest.Server
	loginOK       bool
	gotCloudPRNT  map[string]string
	gotSaveForm   map[string]string
	loginAttempts int
	cloudCalls    int
	saveCalls     int
}

func newFakePrinter(adminPass string) *fakePrinter {
	fp := &fakePrinter{gotCloudPRNT: map[string]string{}, gotSaveForm: map[string]string{}}
	mux := http.NewServeMux()

	mux.HandleFunc("/auth/form_authentication.cgi", func(w http.ResponseWriter, r *http.Request) {
		fp.loginAttempts++
		r.ParseForm()
		if r.PostForm.Get("username") != "root" || r.PostForm.Get("password") != adminPass {
			// Real printer returns 200 + login form on bad creds. No cookie.
			w.WriteHeader(200)
			w.Write([]byte("<html>bad creds</html>"))
			return
		}
		fp.loginOK = true
		http.SetCookie(w, &http.Cookie{Name: "form_authentication_key", Value: "sessfake", Path: "/"})
		w.Header().Set("Location", "/index.htm")
		w.WriteHeader(http.StatusSeeOther)
	})

	requireCookie := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			c, err := r.Cookie("form_authentication_key")
			if err != nil || c.Value != "sessfake" {
				http.Error(w, "no session", 401)
				return
			}
			next(w, r)
		}
	}

	mux.HandleFunc("/html/cloudprnt_cgi", requireCookie(func(w http.ResponseWriter, r *http.Request) {
		fp.cloudCalls++
		r.ParseForm()
		for k := range r.PostForm {
			fp.gotCloudPRNT[k] = r.PostForm.Get(k)
		}
		w.WriteHeader(200)
	}))

	mux.HandleFunc("/html/save_cgi", requireCookie(func(w http.ResponseWriter, r *http.Request) {
		fp.saveCalls++
		r.ParseForm()
		for k := range r.PostForm {
			fp.gotSaveForm[k] = r.PostForm.Get(k)
		}
		w.WriteHeader(200)
	}))

	fp.server = httptest.NewServer(mux)
	return fp
}

func TestDial_GoodCredentials(t *testing.T) {
	fp := newFakePrinter("hunter2")
	defer fp.server.Close()
	s, err := Dial(context.Background(), Credentials{Host: fp.server.URL, AdminPass: "hunter2"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	if !fp.loginOK {
		t.Fatal("login was not recorded as OK")
	}
	s.Close()
}

func TestDial_BadCredentials(t *testing.T) {
	fp := newFakePrinter("hunter2")
	defer fp.server.Close()
	_, err := Dial(context.Background(), Credentials{Host: fp.server.URL, AdminPass: "wrong"})
	if err == nil {
		t.Fatal("expected error on bad password")
	}
	if !strings.Contains(err.Error(), "wrong admin password") {
		t.Fatalf("error should hint at password issue: %v", err)
	}
}

func TestApplyCloudPRNT_SubmitsAllFields(t *testing.T) {
	fp := newFakePrinter("hunter2")
	defer fp.server.Close()
	s, err := Dial(context.Background(), Credentials{Host: fp.server.URL, AdminPass: "hunter2"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}

	err = s.ApplyCloudPRNT(context.Background(), CloudPRNTSettings{
		Enable:         true,
		ServerURL:      "https://cprnt.example/cprnt/p1",
		PollingSec:     5,
		HTTPTimeoutSec: 60,
		Username:       "p1",
		Password:       "secret-supersecret-1234567890ab",
	})
	if err != nil {
		t.Fatalf("ApplyCloudPRNT: %v", err)
	}

	want := map[string]string{
		"cloudprnt_enable_selection": "ENABLE",
		"server_url":                 "https://cprnt.example/cprnt/p1",
		"polling_time":               "5",
		"http_response_timeout":      "60",
		"user_name":                  "p1",
		"cp_password":                "secret-supersecret-1234567890ab",
		"Submit":                     "submit",
	}
	for k, v := range want {
		if got := fp.gotCloudPRNT[k]; got != v {
			t.Errorf("form field %s: got %q want %q", k, got, v)
		}
	}
}

func TestApplyCloudPRNT_RejectsOverlongFields(t *testing.T) {
	fp := newFakePrinter("x")
	defer fp.server.Close()
	s, err := Dial(context.Background(), Credentials{Host: fp.server.URL, AdminPass: "x"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	err = s.ApplyCloudPRNT(context.Background(), CloudPRNTSettings{
		ServerURL: "https://x/" + strings.Repeat("a", 600),
		Username:  "u",
		Password:  "p",
	})
	if err == nil {
		t.Fatal("expected length error")
	}
}

func TestSaveAndRestart_IssuesCorrectForm(t *testing.T) {
	fp := newFakePrinter("x")
	defer fp.server.Close()
	s, err := Dial(context.Background(), Credentials{Host: fp.server.URL, AdminPass: "x"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	if err := s.SaveAndRestart(context.Background()); err != nil {
		t.Fatalf("SaveAndRestart: %v", err)
	}
	if fp.gotSaveForm["radio_sv"] != "r_save_res" {
		t.Errorf("radio_sv = %q, want r_save_res", fp.gotSaveForm["radio_sv"])
	}
	if fp.gotSaveForm["valid_sv"] != "sv_send_ok" {
		t.Errorf("valid_sv = %q, want sv_send_ok", fp.gotSaveForm["valid_sv"])
	}
}

func TestNormalizeHost(t *testing.T) {
	cases := map[string]string{
		"192.168.1.38":         "http://192.168.1.38",
		"http://192.168.1.38":  "http://192.168.1.38",
		"https://printer:8443": "https://printer:8443",
		"printer.local":        "http://printer.local",
	}
	for in, want := range cases {
		got, err := normalizeHost(in)
		if err != nil || got != want {
			t.Errorf("normalizeHost(%q) = (%q, %v), want (%q, nil)", in, got, err, want)
		}
	}
}
