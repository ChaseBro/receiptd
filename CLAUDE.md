# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
make build          # outputs ./receiptd binary
go build -o receiptd ./cmd/receiptd

# Run
./receiptd server               # start server in foreground (Ctrl+C to stop)
./receiptd server --daemon      # start as background daemon
./receiptd server stop

# Test
go test -v ./...

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

```
receiptd print "text"
  → CLI client (internal/client/client.go) sends JSON to :3099
  → Daemon adds Job to Queue (internal/server/queue.go)
  → Star printer polls CloudPRNT endpoint (POST /)
  → Daemon returns jobReady=true with token
  → Printer fetches job content (GET /?token=...&type=...)
  → cloudprnt.go converts Star Markup (.stm) → StarPRNT binary via cputil
  → Printer DELETEs token (data-receipt ack, not print-complete)
  → Printer polls again immediately; daemon gives next queued job
```

### Job sequencing

The Star printer fires two rapid polls per job: one immediately after GET (while still printing — ignored by the server) and one immediately after DELETE (printer is ready — server dispatches next job). `TakeNextJob()` in `queue.go` enforces this atomically:

- Job is `processing` → return nil (post-GET poll; printer is still printing)
- Job is `acknowledged` (DELETE received) → finalize to `completed`, then give next pending job (post-DELETE poll; printer is ready)

### Key files

- `internal/server/daemon.go` — `Daemon` struct orchestrates both servers; `AddJob()` appends `[feed:3][cut]` to every job content; `stop` CLI command triggers graceful shutdown
- `internal/server/cloudprnt.go` — CloudPRNT HTTP handler + `convertToStarPRNT()` calls cputil binary at a hardcoded path
- `internal/server/queue.go` — thread-safe in-memory job queue (no persistence); `TakeNextJob()` is the atomic gate for job sequencing
- `internal/client/client.go` — CLI-to-daemon TCP client using JSON encoding
- `internal/cli/` — Cobra command implementations; `root.go` has `--json` and `--verbose` persistent flags, `OutputJSON`/`ErrorExit` helpers
- `internal/stub/stub.go` — mock data stubs (used by CLI commands that aren't yet wired to the real client)

### Star Markup / cputil

Job content is treated as **Star Markup** (`.stm` format). The CloudPRNT handler shells out to `cputil` (from the Star CloudPRNT SDK) to convert markup → StarPRNT binary. `resolveCputilPath()` in `cloudprnt.go` finds it in priority order:

1. `$CPUTIL_PATH` env var
2. `cputil` on `$PATH`

If neither resolves, the server fails at startup with a clear error. To set up: download the Star CloudPRNT SDK, then either set `CPUTIL_PATH=/path/to/cputil-bin/cputil` or add `cputil` to `$PATH`. Note that the whole `cputil-bin/` directory must remain intact alongside the binary — it loads `.dll` files from its own directory at runtime.

Star Markup syntax: `[align: center]`, `[bold: on]`/`[bold: off]`, `[col: left X; right Y]`, `[feed]`, `[cut]`. Full tag reference: https://star-m.jp/products/s_print/sdk/StarDocumentMarkup/manual/en/tag-reference/index.html. `AddJob()` always appends `[feed:3][cut]` — callers must not include `[cut]` themselves. cputil conversion is required; there is no plain-text fallback (a cputil error returns HTTP 500).

### Data / config

- Server data directory: `~/.receiptd/`
- Log file: `~/.receiptd/receiptd.log`
- Config (not yet implemented): `~/.receiptd/config.yaml`
- Job queue is in-memory only — jobs are lost on restart

### Exit codes

- `0` — Success
- `1` — General error
- `2` — Server not running
- `3` — Printer error
- `4` — Configuration error

### Stub vs real implementation

Several CLI commands in `internal/cli/` still call `internal/stub/stub.go` instead of the real client. The actual `internal/client/client.go` is only used for commands that need live server data. When wiring up a stub command to the real server, replace `stub.Foo()` calls with `client.NewClient().Foo()`.
