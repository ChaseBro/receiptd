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

2. **CLI TCP server** (`127.0.0.1:3099`) — JSON-over-TCP for CLI commands (`status`, `add_job`, `get_jobs`).

### Request flow

```
receiptd print "text"
  → CLI client (internal/client/client.go) sends JSON to :3099
  → Daemon adds Job to Queue (internal/server/queue.go)
  → Star printer polls CloudPRNT endpoint (POST /)
  → Daemon returns jobReady=true with token
  → Printer fetches job content (GET /?token=...&type=...)
  → cloudprnt.go converts Star Markup (.stm) → StarPRNT binary via cputil
  → Printer DELETEs token to confirm completion
```

### Key files

- `internal/server/daemon.go` — `Daemon` struct orchestrates both servers; `AddJob()` appends `[feed:3][cut]` to every job content
- `internal/server/cloudprnt.go` — CloudPRNT HTTP handler + `convertToStarPRNT()` calls cputil binary at a hardcoded path
- `internal/server/queue.go` — thread-safe in-memory job queue (no persistence)
- `internal/client/client.go` — CLI-to-daemon TCP client using JSON encoding
- `internal/cli/` — Cobra command implementations; `root.go` has `--json` and `--verbose` persistent flags, `OutputJSON`/`ErrorExit` helpers
- `internal/stub/stub.go` — mock data stubs (used by CLI commands that aren't yet wired to the real client)

### Star Markup / cputil

Job content is treated as **Star Markup** (`.stm` format). The CloudPRNT handler shells out to `cputil` (from the Star CloudPRNT SDK) to convert markup → StarPRNT binary. The cputil binary path is **hardcoded** in `cloudprnt.go:29`:
```
/Users/chase/.openclaw/workspace/projects/print-booth/cloudprnt-sdk/cputil-bin/cputil
```

Star Markup syntax examples: `[align:center]`, `[bold:on]`/`[bold:off]`, `[feed:N]`, `[cut]`. `AddJob()` always appends `[feed:3][cut]` — callers should not include `[cut]` themselves. cputil conversion is required; there is no plain-text fallback (a cputil error returns HTTP 500).

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
