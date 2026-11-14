package printerconfig

import (
	"context"
	"net/http"
	"testing"
)

const sampleCloudPRNTPage = `<html><head><title>CloudPRNT &amp; Settings</title></head><body>
<form name="f" method="post" action="/html/cloudprnt_cgi">
<input type="radio" name="cloudprnt_enable_selection" value="ENABLE" checked>
<input type="radio" name="cloudprnt_enable_selection" value="DISABLE">
<input type=text name="server_url" value="https://cprnt.receiptd.sh/cprnt/printer-prod-3838" maxlength=511>
<input name='polling_time' value='5'>
<select name="http_response_timeout"><option value="10">10</option><option value="60" selected>60</option></select>
<input type="text" name="user_name" value="printer-prod-3838">
<input type="password" name="cp_password" value="rdp_supersecret">
<textarea name="notes">a &lt;b&gt;</textarea>
<input type="submit" value="Submit">
</form></body></html>`

func TestParsePage(t *testing.T) {
	p := ParsePage(sampleCloudPRNTPage)
	if p.Title != "CloudPRNT & Settings" {
		t.Errorf("title = %q", p.Title)
	}
	if len(p.Forms) != 1 || p.Forms[0] != "/html/cloudprnt_cgi" {
		t.Errorf("forms = %v", p.Forms)
	}
	want := []string{"cloudprnt_enable_selection", "cloudprnt_enable_selection", "server_url", "polling_time", "http_response_timeout", "user_name", "cp_password", "notes"}
	if len(p.Fields) != len(want) {
		t.Fatalf("got %d fields %+v, want %d", len(p.Fields), p.Fields, len(want))
	}
	for i, n := range want {
		if p.Fields[i].Name != n {
			t.Errorf("field %d = %q, want %q", i, p.Fields[i].Name, n)
		}
	}
	if !p.Fields[0].Checked || p.Fields[1].Checked {
		t.Errorf("radio checked state wrong: %+v %+v", p.Fields[0], p.Fields[1])
	}
	if p.Fields[3].Type != "text" || p.Fields[3].Value != "5" {
		t.Errorf("untyped input should default to text with value: %+v", p.Fields[3])
	}
	sel := p.Fields[4]
	if sel.Tag != "select" || sel.Selected != "60" || len(sel.Options) != 2 {
		t.Errorf("select parsed wrong: %+v", sel)
	}
	if pw := p.Fields[6]; pw.Type != "password" || pw.Value != "" {
		t.Errorf("password must be redacted: %+v", pw)
	}
	if ta := p.Fields[7]; ta.Value != "a <b>" {
		t.Errorf("textarea = %q", ta.Value)
	}
	if got := p.FieldsMatching("MQTT", "broker"); len(got) != 0 {
		t.Errorf("unexpected mqtt fields: %+v", got)
	}
	if got := p.FieldsMatching("url"); len(got) != 1 || got[0].Name != "server_url" {
		t.Errorf("FieldsMatching(url) = %+v", got)
	}
}

func TestInspect_IsReadOnlyGET(t *testing.T) {
	fp := newFakePrinter("hunter2")
	defer fp.server.Close()

	var methods []string
	inner := fp.server.Config.Handler
	fp.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == PageCloudPRNT {
			methods = append(methods, r.Method)
			if c, err := r.Cookie("form_authentication_key"); err != nil || c.Value != "sessfake" {
				http.Error(w, "no session", 401)
				return
			}
			w.Write([]byte(sampleCloudPRNTPage))
			return
		}
		inner.ServeHTTP(w, r)
	})

	s, err := Dial(context.Background(), Credentials{Host: fp.server.URL, AdminPass: "hunter2"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	p, err := s.Inspect(context.Background(), PageCloudPRNT)
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if p.Status != 200 || len(p.Fields) == 0 {
		t.Fatalf("page = %+v", p)
	}
	if len(methods) != 1 || methods[0] != http.MethodGet {
		t.Errorf("methods = %v, want exactly one GET", methods)
	}
	if fp.cloudCalls != 0 || fp.saveCalls != 0 {
		t.Errorf("Inspect must not POST config (cloud=%d save=%d)", fp.cloudCalls, fp.saveCalls)
	}
}
