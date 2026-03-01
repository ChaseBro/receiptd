# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
make build          # outputs ./receiptd binary
go build -o receiptd ./cmd/receiptd

# Run
./receiptd server               # start server in foreground (Ctrl+C to stop)
./receiptd server stop

# Print (HTML rendering — preferred, supports emojis/CSS/images)
./receiptd render --output /tmp/preview.png '<html>...'   # preview
./receiptd print --render '<html>...'                     # print
./receiptd print --render - < file.html                   # from file

# Print (Star Markup — text-only)
./receiptd print '[bold:on]Hello[bold:off]'

# Print with image file
./receiptd print --image /path/to/photo.png "caption"

# Test
go test -v -count=1 ./...

# Clean
make clean
```

## Architecture

`receiptd` is a thermal receipt printer daemon for Star TSP100IV printers using the **CloudPRNT** protocol.

### Two-server design

The daemon (`internal/server/daemon.go`) runs two concurrent servers:

1. **CloudPRNT HTTP server** (`:3000`) — implements the Star CloudPRNT polling protocol. Star printers poll this server periodically via POST, then GET job content, then DELETE to acknowledge completion.

2. **CLI TCP server** (`127.0.0.1:3099`) — JSON-over-TCP for CLI commands (`status`, `add_job`, `get_jobs`, `stop`).

### Request flow

**HTML render path** (`--render`):
```
receiptd print --render '<html>...'
  → internal/render/render.go launches headless Chrome at 576px
  → Chrome renders HTML → full-page PNG saved to ~/.receiptd/renders/
  → CLI client sends add_job with imagePath to :3099
  → Daemon queues job with ImagePath set
  → Star printer polls CloudPRNT endpoint (POST /)
  → Daemon returns jobReady=true with token
  → Printer fetches job (GET /?token=...&type=...)
  → cloudprnt.go prepends [image: url file://...] to Star Markup
  → cputil converts markup → StarPRNT binary
  → Printer DELETEs token → job complete
```

**Text / Star Markup path**:
```
receiptd print "text"
  → CLI client sends JSON to :3099
  → Daemon adds Job to Queue (internal/server/queue.go)
  → Star printer polls, GETs, cputil converts markup → binary, printer DELETEs
```

### Job sequencing

The Star printer fires two rapid polls per job: one immediately after GET (while still printing — ignored by the server) and one immediately after DELETE (printer is ready — server dispatches next job). `TakeNextJob()` in `queue.go` enforces this atomically:

- Job is `processing` → return nil (post-GET poll; printer is still printing)
- Job is `acknowledged` (DELETE received) → finalize to `completed`, then give next pending job (post-DELETE poll; printer is ready)

### Key files

- `internal/server/daemon.go` — `Daemon` struct orchestrates both servers; `AddJob()` appends `[feed:3][cut]` to every job content; `stop` CLI command triggers graceful shutdown
- `internal/server/cloudprnt.go` — CloudPRNT HTTP handler; `convertToStarPRNT()` calls cputil; `handleGetJob()` prepends `[image: url file://...]` when `job.ImagePath` is set
- `internal/server/queue.go` — thread-safe in-memory job queue; `TakeNextJob()` is the atomic gate for job sequencing
- `internal/render/render.go` — `HTMLToPNG(html, width)` renders HTML via headless Chrome to a PNG at printer width (576px); `SaveRender()` persists to `~/.receiptd/renders/`
- `internal/client/client.go` — CLI-to-daemon TCP client using JSON encoding
- `internal/cli/print.go` — `print` command; `--render` claims stdin before message reader to avoid conflict; `--image` and `--render` are mutually exclusive
- `internal/cli/render.go` — standalone `render` subcommand for previewing HTML before printing
- `internal/cli/` — other Cobra command implementations; `root.go` has `--json` and `--verbose` persistent flags
- `internal/stub/stub.go` — mock data stubs (used by CLI commands that aren't yet wired to the real client)

### Star Markup / cputil

Job content is treated as **Star Markup** (`.stm` format). The CloudPRNT handler shells out to `cputil` (from the Star CloudPRNT SDK) to convert markup → StarPRNT binary. `resolveCputilPath()` in `cloudprnt.go` finds it in priority order:

1. `$CPUTIL_PATH` env var
2. `cputil` on `$PATH`

If neither resolves, the server fails at startup with a clear error. Set `CPUTIL_PATH` in `.env` at the project root — it's loaded automatically at startup via `loadDotEnv()` in `main.go`. Note that the whole `cputil-bin/` directory must remain intact alongside the binary — it loads support files from its own directory at runtime.

Star Markup syntax: `[align: center]`, `[bold: on]`/`[bold: off]`, `[col: left X; right Y]`, `[feed]`, `[cut]`. Full tag reference: https://star-m.jp/products/s_print/sdk/StarDocumentMarkup/manual/en/tag-reference/index.html. `AddJob()` always appends `[feed:3][cut]` — callers must not include `[cut]` themselves. cputil conversion is required; a cputil error returns HTTP 500.

### HTML rendering / `--render`

`internal/render/render.go` wraps `chromedp` to launch headless Chrome and take a full-page PNG screenshot:

- Viewport width: **576px** (80mm at 203 DPI — matches printer paper)
- Viewport height: **1px** initially, so Chrome's root element doesn't stretch; `FullScreenshot` expands to actual content height
- Flags: `--headless`, `--no-sandbox`, `--disable-gpu`, `--password-store=basic`, `--use-mock-keychain` (suppresses macOS Keychain dialog)
- Rendered PNGs saved to `~/.receiptd/renders/<timestamp>.png`
- Requires Chrome or Chromium installed; `requireChrome()` in integration tests skips gracefully if absent

### Data / config

- Server data directory: `~/.receiptd/`
- Log file: `~/.receiptd/receiptd.log`
- SQLite database: `~/.receiptd/receiptd.db` — jobs and printers are persisted; pending jobs are recovered on restart
- Rendered PNGs: `~/.receiptd/renders/`
- `.env` at project root is loaded at startup (shell env takes precedence)

### Exit codes

- `0` — Success
- `1` — General error
- `2` — Server not running
- `3` — Printer error
- `4` — Configuration error

### Stub vs real implementation

Several CLI commands in `internal/cli/` still call `internal/stub/stub.go` instead of the real client. The actual `internal/client/client.go` is only used for commands that need live server data. When wiring up a stub command to the real server, replace `stub.Foo()` calls with `client.NewClient().Foo()`.
