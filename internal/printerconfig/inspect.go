package printerconfig

import (
	"context"
	"fmt"
	"html"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// Read-only inspection of the printer web UI. Used to discover form field
// names on firmware we haven't probed yet (e.g. whether a given firmware
// exposes any CloudPRNT MQTT fields — per Star's docs it should not: MQTT
// Trigger POST is switched on by the server's cloudprnt-setting.json, see
// docs/cloudprnt-mqtt.md). Nothing here POSTs or changes printer state.

// Well-known read-only pages on the TSP100IV web UI.
const (
	PageCloudPRNT = "/html/cloudprnt.htm"
)

// FormField is one <input>/<select>/<textarea> found on a page.
type FormField struct {
	Tag   string // input | select | textarea
	Type  string // input type (text, password, radio, hidden, ...); empty for select/textarea
	Name  string
	Value string // current value; "" for password fields (always redacted)
	// Checked is set for checked radio/checkbox inputs.
	Checked bool
	// Options lists <option value> entries for selects.
	Options []string
	// Selected is the selected <option> value for selects.
	Selected string
}

// Page is the result of a read-only GET.
type Page struct {
	Path   string
	Status int
	Title  string
	Forms  []string // form action attributes, in document order
	Fields []FormField
}

// Get fetches a page with the session cookie. It never follows redirects
// (the client is configured not to); a 3xx usually means the session
// expired.
func (s *Session) Get(ctx context.Context, path string) (*http.Response, error) {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.base+path, nil)
	if err != nil {
		return nil, err
	}
	return s.http.Do(req)
}

// Inspect GETs path and extracts form actions and fields. Password values
// are redacted so output is safe to paste into an issue or doc.
func (s *Session) Inspect(ctx context.Context, path string) (*Page, error) {
	resp, err := s.Get(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("inspect %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, fmt.Errorf("inspect %s: %w", path, err)
	}
	p := ParsePage(string(body))
	p.Path = path
	p.Status = resp.StatusCode
	return p, nil
}

var (
	reTitle    = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	reForm     = regexp.MustCompile(`(?is)<form\b([^>]*)>`)
	reInput    = regexp.MustCompile(`(?is)<input\b([^>]*)>`)
	reSelect   = regexp.MustCompile(`(?is)<select\b([^>]*)>(.*?)</select>`)
	reOption   = regexp.MustCompile(`(?is)<option\b([^>]*)>`)
	reTextarea = regexp.MustCompile(`(?is)<textarea\b([^>]*)>(.*?)</textarea>`)
	reAttr     = regexp.MustCompile(`(?is)([a-z_:][-a-z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?`)
)

// attrs parses an HTML attribute string into a lowercase-keyed map. Boolean
// attributes (e.g. "checked") map to "".
func attrs(s string) map[string]string {
	out := map[string]string{}
	for _, m := range reAttr.FindAllStringSubmatch(s, -1) {
		k := strings.ToLower(m[1])
		v := m[2]
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') {
			v = v[1 : len(v)-1]
		}
		if _, dup := out[k]; !dup {
			out[k] = html.UnescapeString(v)
		}
	}
	return out
}

// ParsePage extracts title, form actions and named fields from an HTML page.
// Regex-based on purpose: the printer's pages are small, static, and
// machine-generated; pulling in an HTML parser isn't worth a dependency.
func ParsePage(doc string) *Page {
	p := &Page{}
	if m := reTitle.FindStringSubmatch(doc); m != nil {
		p.Title = strings.TrimSpace(html.UnescapeString(m[1]))
	}
	for _, m := range reForm.FindAllStringSubmatch(doc, -1) {
		p.Forms = append(p.Forms, attrs(m[1])["action"])
	}

	type hit struct {
		pos int
		f   FormField
	}
	var hits []hit

	for _, loc := range reInput.FindAllStringSubmatchIndex(doc, -1) {
		a := attrs(doc[loc[2]:loc[3]])
		if a["name"] == "" {
			continue
		}
		typ := strings.ToLower(a["type"])
		if typ == "" {
			typ = "text"
		}
		f := FormField{Tag: "input", Type: typ, Name: a["name"], Value: a["value"]}
		if _, ok := a["checked"]; ok {
			f.Checked = true
		}
		if typ == "password" {
			f.Value = ""
		}
		hits = append(hits, hit{loc[0], f})
	}
	for _, loc := range reSelect.FindAllStringSubmatchIndex(doc, -1) {
		a := attrs(doc[loc[2]:loc[3]])
		if a["name"] == "" {
			continue
		}
		f := FormField{Tag: "select", Name: a["name"]}
		for _, om := range reOption.FindAllStringSubmatch(doc[loc[4]:loc[5]], -1) {
			oa := attrs(om[1])
			f.Options = append(f.Options, oa["value"])
			if _, ok := oa["selected"]; ok {
				f.Selected = oa["value"]
			}
		}
		hits = append(hits, hit{loc[0], f})
	}
	for _, loc := range reTextarea.FindAllStringSubmatchIndex(doc, -1) {
		a := attrs(doc[loc[2]:loc[3]])
		if a["name"] == "" {
			continue
		}
		hits = append(hits, hit{loc[0], FormField{Tag: "textarea", Name: a["name"], Value: html.UnescapeString(doc[loc[4]:loc[5]])}})
	}

	// Document order, so radio groups and sections read naturally.
	for i := 1; i < len(hits); i++ {
		for j := i; j > 0 && hits[j].pos < hits[j-1].pos; j-- {
			hits[j], hits[j-1] = hits[j-1], hits[j]
		}
	}
	for _, h := range hits {
		p.Fields = append(p.Fields, h.f)
	}
	return p
}

// FieldsMatching returns fields whose name contains any of the given
// case-insensitive substrings (e.g. "mqtt", "broker").
func (p *Page) FieldsMatching(subs ...string) []FormField {
	var out []FormField
	for _, f := range p.Fields {
		n := strings.ToLower(f.Name)
		for _, s := range subs {
			if strings.Contains(n, strings.ToLower(s)) {
				out = append(out, f)
				break
			}
		}
	}
	return out
}
