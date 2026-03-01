package integration_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var binary string

// CloudPRNTPollResponse mirrors the struct in server/cloudprnt.go.
type CloudPRNTPollResponse struct {
	JobReady     bool     `json:"jobReady"`
	MediaTypes   []string `json:"mediaTypes"`
	JobToken     string   `json:"jobToken,omitempty"`
	PollInterval int      `json:"pollInterval"`
	DeleteMethod string   `json:"deleteMethod"`
}

func TestMain(m *testing.M) {
	tmp, _ := os.MkdirTemp("", "receiptd-inttest-*")
	binary = filepath.Join(tmp, "receiptd")
	out, err := exec.Command("go", "build", "-o", binary, "../cmd/receiptd").CombinedOutput()
	if err != nil {
		fmt.Fprintf(os.Stderr, "build failed: %s\n%s\n", err, out)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(tmp)
	os.Exit(code)
}

// fakeCputil writes a minimal shell script that outputs StarPRNT init bytes.
func fakeCputil(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cputil")
	os.WriteFile(path, []byte("#!/bin/sh\nprintf '\\x1b\\x40'\n"), 0755)
	return path
}

// fakeCputilCapturing writes a shell script that captures the .stm input file
// to captureFile and then outputs StarPRNT init bytes.
func fakeCputilCapturing(t *testing.T, captureFile string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cputil")
	// $4 is the .stm file path (args: thermal3 decode <mediatype> <file> -)
	script := "#!/bin/sh\ncat \"$4\" > " + captureFile + "\nprintf '\\x1b\\x40'\n"
	os.WriteFile(path, []byte(script), 0755)
	return path
}

// minimalPNG returns the bytes of a 1×1 white PNG, created with the stdlib.
func minimalPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, color.White)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode PNG: %v", err)
	}
	return buf.Bytes()
}

// testEnv returns a minimal subprocess environment with an isolated HOME.
// If cputil is non-empty, CPUTIL_PATH is set to that path.
func testEnv(t *testing.T, cputil string) []string {
	t.Helper()
	env := []string{"HOME=" + t.TempDir(), "PATH=/usr/bin:/bin"}
	if cputil != "" {
		env = append(env, "CPUTIL_PATH="+cputil)
	}
	return env
}

// startServer starts receiptd server in the background, waits up to 5s for
// port 3099, and registers a cleanup to kill the process.
func startServer(t *testing.T, env []string) {
	t.Helper()
	requirePortFree(t, "127.0.0.1:3099")
	cmd := exec.Command(binary, "server")
	cmd.Env = env
	if err := cmd.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	if !waitForPort("127.0.0.1:3099", 5*time.Second) {
		t.Fatal("server did not become ready in time")
	}
}

// requirePortFree skips the test if something is already listening on addr.
func requirePortFree(t *testing.T, addr string) {
	t.Helper()
	if c, err := net.DialTimeout("tcp", addr, 100*time.Millisecond); err == nil {
		c.Close()
		t.Skipf("port %s is already in use — skipping to avoid clobbering dev server", addr)
	}
}

// waitForPort polls until addr accepts a TCP connection or timeout elapses.
func waitForPort(addr string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if c, err := net.DialTimeout("tcp", addr, 100*time.Millisecond); err == nil {
			c.Close()
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// waitForPortClosed polls until addr stops accepting connections or timeout elapses.
func waitForPortClosed(addr string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if c, err := net.DialTimeout("tcp", addr, 100*time.Millisecond); err != nil {
			return true
		} else {
			c.Close()
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// cloudprntPoll sends a CloudPRNT POST poll and returns the parsed response.
func cloudprntPoll(t *testing.T, body string) CloudPRNTPollResponse {
	t.Helper()
	resp, err := http.Post("http://localhost:3000/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("cloudprntPoll: %v", err)
	}
	defer resp.Body.Close()
	var result CloudPRNTPollResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("cloudprntPoll decode: %v", err)
	}
	return result
}

// cloudprntGet fetches a job's StarPRNT binary content.
func cloudprntGet(t *testing.T, token string) ([]byte, int) {
	t.Helper()
	resp, err := http.Get(fmt.Sprintf("http://localhost:3000/?token=%s&type=application/vnd.star.starprnt", token))
	if err != nil {
		t.Fatalf("cloudprntGet: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return body, resp.StatusCode
}

// cloudprntDelete sends the DELETE acknowledgement for a token.
func cloudprntDelete(t *testing.T, token string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("http://localhost:3000/?token=%s", token), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("cloudprntDelete: %v", err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// TestServerNoCputil verifies the server exits 1 with a clear message when
// cputil is not found.
func TestServerNoCputil(t *testing.T) {
	requirePortFree(t, "127.0.0.1:3099")
	requirePortFree(t, "127.0.0.1:3000")

	cmd := exec.Command(binary, "server")
	cmd.Env = testEnv(t, "") // no CPUTIL_PATH, restricted PATH
	out, _ := cmd.CombinedOutput()
	if cmd.ProcessState.ExitCode() != 1 {
		t.Errorf("want exit code 1, got %d\noutput: %s", cmd.ProcessState.ExitCode(), out)
	}
	if !strings.Contains(string(out), "cputil not found") {
		t.Errorf("want 'cputil not found' in output, got:\n%s", out)
	}
}

// TestPrintNoServer verifies that when no server is running and auto-start
// also fails (no cputil), the print command falls back to the stub and exits 0.
func TestPrintNoServer(t *testing.T) {
	requirePortFree(t, "127.0.0.1:3099")

	cmd := exec.Command(binary, "print", "hello")
	cmd.Env = testEnv(t, "")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("want exit 0, got error: %v\noutput: %s", err, out)
	}
	if !strings.Contains(string(out), "stub") {
		t.Errorf("want 'stub' in output, got:\n%s", out)
	}
}

// TestPrintStagedServerRunning verifies that print --staged submits a real job
// to a running server and returns a job ID.
func TestPrintStagedServerRunning(t *testing.T) {
	env := testEnv(t, fakeCputil(t))
	startServer(t, env)

	cmd := exec.Command(binary, "print", "--staged", "integration test job")
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("want exit 0, got error: %v\noutput: %s", err, out)
	}
	if !strings.Contains(string(out), "Job ID: job-") {
		t.Errorf("want 'Job ID: job-' in output, got:\n%s", out)
	}
}

// TestServerStop verifies that the stop command shuts the server down and the
// CLI port closes within 5 seconds.
func TestServerStop(t *testing.T) {
	env := testEnv(t, fakeCputil(t))
	startServer(t, env)

	cmd := exec.Command(binary, "server", "stop")
	cmd.Env = env
	if err := cmd.Run(); err != nil {
		t.Fatalf("server stop: want exit 0, got %v", err)
	}
	if !waitForPortClosed("127.0.0.1:3099", 5*time.Second) {
		t.Error("port 3099 did not close within 5s after stop")
	}
}

// TestStatus verifies that the status command exits 0.
// (Currently a stub — will be upgraded when status is wired to the real server.)
func TestStatus(t *testing.T) {
	cmd := exec.Command(binary, "status")
	cmd.Env = testEnv(t, "")
	if err := cmd.Run(); err != nil {
		t.Fatalf("status: want exit 0, got %v", err)
	}
}

// TestPrinterJobLifecycle simulates the full CloudPRNT polling sequence the
// Star TSP100IV uses: poll → GET → rapid post-GET poll → DELETE → poll.
func TestPrinterJobLifecycle(t *testing.T) {
	env := testEnv(t, fakeCputil(t))
	requirePortFree(t, "127.0.0.1:3099")
	requirePortFree(t, "127.0.0.1:3000")
	startServer(t, env)

	// Submit a non-staged job via CLI.
	printCmd := exec.Command(binary, "print", "integration test job")
	printCmd.Env = env
	if err := printCmd.Run(); err != nil {
		t.Fatalf("print: %v", err)
	}

	poll := `{"printerMAC":"aa:bb:cc:dd:ee:ff","statusCode":"NORMAL","clientAction":[]}`

	// Poll #1: pending → processing; expect jobReady=true with a token.
	r1 := cloudprntPoll(t, poll)
	if !r1.JobReady {
		t.Fatal("poll 1: want jobReady=true")
	}
	token := r1.JobToken
	if token == "" {
		t.Fatal("poll 1: want non-empty jobToken")
	}

	// GET: fetch job content; expect 200 with binary body.
	body, code := cloudprntGet(t, token)
	if code != 200 || len(body) == 0 {
		t.Fatalf("GET: want 200 + non-empty body, got %d (%d bytes)", code, len(body))
	}

	// Poll #2 (rapid post-GET): job still "processing" → must return jobReady=false.
	r2 := cloudprntPoll(t, poll)
	if r2.JobReady {
		t.Error("poll 2 post-GET: want jobReady=false while printing")
	}

	// DELETE: printer acknowledges receipt → job transitions to "acknowledged".
	if sc := cloudprntDelete(t, token); sc != 204 {
		t.Fatalf("DELETE: want 204, got %d", sc)
	}

	// Poll #3 (post-DELETE): "acknowledged" finalized to "completed", no more
	// pending jobs → jobReady=false.
	r3 := cloudprntPoll(t, poll)
	if r3.JobReady {
		t.Error("poll 3 post-DELETE: want jobReady=false after completion")
	}
}

// TestPrintImageMissingFile verifies that --image with a non-existent path
// exits non-zero with a clear error before contacting the server.
func TestPrintImageMissingFile(t *testing.T) {
	requirePortFree(t, "127.0.0.1:3099")

	cmd := exec.Command(binary, "print", "--image", "/nonexistent/no-such-image.png", "caption")
	cmd.Env = testEnv(t, "")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("want non-zero exit for missing image, got exit 0\noutput: %s", out)
	}
	if !strings.Contains(string(out), "not found") {
		t.Errorf("want 'not found' in output, got:\n%s", out)
	}
}

// TestPrintImageStaged verifies that --image with a valid file submits a job
// successfully when a server is running.
func TestPrintImageStaged(t *testing.T) {
	env := testEnv(t, fakeCputil(t))
	startServer(t, env)

	imgPath := filepath.Join(t.TempDir(), "test.png")
	if err := os.WriteFile(imgPath, minimalPNG(t), 0644); err != nil {
		t.Fatalf("write test image: %v", err)
	}

	cmd := exec.Command(binary, "print", "--staged", "--image", imgPath, "photo caption")
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("want exit 0, got %v\noutput: %s", err, out)
	}
	if !strings.Contains(string(out), "Job ID: job-") {
		t.Errorf("want 'Job ID: job-' in output, got:\n%s", out)
	}
}

// requireChrome skips the test if Chrome or Chromium is not installed.
func requireChrome(t *testing.T) {
	t.Helper()
	// Check macOS app bundles first, then PATH.
	knownPaths := []string{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	}
	for _, p := range knownPaths {
		if _, err := os.Stat(p); err == nil {
			return
		}
	}
	for _, name := range []string{"google-chrome", "chromium-browser", "chromium", "chrome"} {
		if _, err := exec.LookPath(name); err == nil {
			return
		}
	}
	t.Skip("Chrome or Chromium not found — skipping render tests (install Chrome to enable)")
}

// TestRenderCommand verifies that `receiptd render` produces a valid PNG file.
func TestRenderCommand(t *testing.T) {
	requireChrome(t)

	outFile := filepath.Join(t.TempDir(), "out.png")
	html := `<!DOCTYPE html><html><body style="margin:0;background:#fff;font-size:24px;width:576px">
<h1 style="text-align:center">Test Receipt</h1>
<p>Integration test render</p>
</body></html>`

	cmd := exec.Command(binary, "render", "--output", outFile, html)
	cmd.Env = testEnv(t, "")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("render command failed: %v\noutput: %s", err, out)
	}

	// Verify the output file exists and is a valid PNG.
	data, err := os.ReadFile(outFile)
	if err != nil {
		t.Fatalf("output file not found: %v", err)
	}
	if len(data) < 8 {
		t.Fatalf("output file too small (%d bytes)", len(data))
	}
	// PNG magic bytes: \x89PNG\r\n\x1a\n
	pngMagic := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	if !bytes.HasPrefix(data, pngMagic) {
		t.Errorf("output is not a PNG (bad magic bytes): %x", data[:8])
	}
	t.Logf("Rendered PNG: %d bytes at %s", len(data), outFile)
}

// TestPrintRenderStaged verifies that `receiptd print --render --staged`
// renders HTML to a PNG and submits a staged job with an image.
func TestPrintRenderStaged(t *testing.T) {
	requireChrome(t)

	env := testEnv(t, fakeCputil(t))
	startServer(t, env)

	html := `<!DOCTYPE html><html><body style="margin:0;width:576px;font-size:24px">
<h1 style="text-align:center">Render Test</h1></body></html>`

	cmd := exec.Command(binary, "print", "--staged", "--render", html)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("want exit 0, got %v\noutput: %s", err, out)
	}
	if !strings.Contains(string(out), "Job ID: job-") {
		t.Errorf("want 'Job ID: job-' in output, got:\n%s", out)
	}
}

// TestImageJobLifecycle verifies the full CloudPRNT polling sequence for an
// image job, and asserts that the [image: url file://...] tag is present in
// the Star Markup that reaches cputil.
func TestImageJobLifecycle(t *testing.T) {
	captureFile := filepath.Join(t.TempDir(), "cputil-capture.stm")
	env := testEnv(t, fakeCputilCapturing(t, captureFile))
	requirePortFree(t, "127.0.0.1:3099")
	requirePortFree(t, "127.0.0.1:3000")
	startServer(t, env)

	imgPath := filepath.Join(t.TempDir(), "photo.png")
	if err := os.WriteFile(imgPath, minimalPNG(t), 0644); err != nil {
		t.Fatalf("write test image: %v", err)
	}

	printCmd := exec.Command(binary, "print", "--image", imgPath, "photo caption")
	printCmd.Env = env
	if err := printCmd.Run(); err != nil {
		t.Fatalf("print: %v", err)
	}

	poll := `{"printerMAC":"aa:bb:cc:dd:ee:ff","statusCode":"NORMAL","clientAction":[]}`

	r1 := cloudprntPoll(t, poll)
	if !r1.JobReady {
		t.Fatal("poll 1: want jobReady=true")
	}

	// GET triggers cputil; the capturing fake writes the .stm to captureFile.
	body, code := cloudprntGet(t, r1.JobToken)
	if code != 200 || len(body) == 0 {
		t.Fatalf("GET: want 200 + non-empty body, got %d (%d bytes)", code, len(body))
	}

	// Verify the markup that reached cputil contains the image tag and caption.
	captured, err := os.ReadFile(captureFile)
	if err != nil {
		t.Fatalf("read cputil capture: %v", err)
	}
	markup := string(captured)
	if !strings.Contains(markup, "[image: url file://"+imgPath) {
		t.Errorf("want [image: url file://%s] in markup, got:\n%s", imgPath, markup)
	}
	if !strings.Contains(markup, "photo caption") {
		t.Errorf("want 'photo caption' in markup, got:\n%s", markup)
	}
}
