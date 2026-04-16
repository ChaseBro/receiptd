# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
make build          # outputs ./receiptd binary
go build -o receiptd ./cmd/receiptd

# Run
./receiptd server               # start server in foreground (Ctrl+C to stop)
./receiptd server --require-auth # require bearer-token auth even for loopback (cloud-mode simulation)
./receiptd server stop

# Auth (remote / multi-tenant — see docs/CLOUD_ROADMAP.md)
./receiptd login --api https://api.example.com  # OAuth 2.0 device flow — caches token in ~/.receiptd/auth.json
./receiptd whoami                                # show current identity (loopback | user | apikey)
./receiptd logout                                # clear cached auth state
./receiptd auth keys create --label "laptop" --scope jobs:write --scope jobs:read
./receiptd auth keys list
./receiptd auth keys revoke rd_live_abcd

# Remote CLI — any command accepts --api / --api-key (or RECEIPTD_API / RECEIPTD_API_KEY env)
./receiptd --api https://api.example.com --api-key rd_live_… print "hello"
RECEIPTD_API=https://api.example.com RECEIPTD_API_KEY=rd_live_… ./receiptd print "hello"

# Render (saves to ~/.receiptd/renders/render-<id>.png)
./receiptd render '<html>...'                             # saves + shows ID + preview hint
./receiptd render --output /tmp/preview.png '<html>...'   # save to specific path
open /tmp/preview.png

# Print the saved render — no re-render, add dithering here
./receiptd renders print a3f2c --dither floyd-steinberg   # by short ID (shown after render)
./receiptd renders list                                   # list all renders with IDs
# or by path (when --output was used):
./receiptd print --image /tmp/preview.png --dither floyd-steinberg

# Print (Star Markup — text-only)
./receiptd print '[bold:on]Hello[bold:off]'

# Print with image file
./receiptd print --image /path/to/photo.png "caption"

# Image processing flags (work with --render and --image)
./receiptd print --render '<html>...' --dither floyd-steinberg
./receiptd print --image photo.png --dither atkinson --brightness 10 --contrast 20
./receiptd render --dither hilbert --gamma 1.5 --output /tmp/out.png '<html>...'
# Algorithms: none|threshold|floyd-steinberg|atkinson|bayer|hilbert|blue-noise
# --brightness -100–100 (0 = no change)
# --contrast   -100–100 (0 = no change)
# --gamma      0.5–2.5  (1.0 = no change)

# Bitmap fonts (eliminate anti-aliasing on thermal paper)
./receiptd fonts list                              # all fonts in registry (16 total)
./receiptd fonts list --installed                  # only installed fonts
./receiptd fonts list --tag receipt                # filter by tag
./receiptd fonts info press-start-2p               # show metadata + install instructions
./receiptd fonts install press-start-2p            # auto-install (AutoInstall fonts only)
./receiptd fonts install press-start-2p --yes      # skip license prompt
./receiptd fonts add ~/Downloads/myfont.ttf        # copy a manually downloaded font
./receiptd fonts remove vcr-osd-mono               # delete installed font

# --font flag: injects font into HTML before Chrome renders it
./receiptd render --font press-start-2p --output /tmp/out.png '<html>...'
./receiptd print --render '<html>...' --font press-start-2p
./receiptd lib preview html-basic --font press-start-2p
./receiptd lib run html-basic --font press-start-2p
# Missing font = hard fail with install hint (no silent fallback)
# Font sizing guide: 8px (ultra-compact), 16px (body), 24px (headers)

# Test
go test -v -count=1 ./...

# Clean
make clean
```

## Architecture

`receiptd` is a thermal receipt printer daemon for Star TSP100IV printers using the **CloudPRNT** protocol.

### Two-server design

The daemon (`internal/server/daemon.go`) runs two concurrent servers:

1. **HTTP server** (`:3000`) — single server with a ServeMux routing two sets of endpoints:
   - **CloudPRNT** at `/` — Star printers poll POST / then GET / then DELETE / to run the polling protocol. Unauthenticated; per-printer HTTP Basic will land in Step 8.
   - **REST v1** at `/v1/*` — JSON API for humans and agents (`/v1/healthz`, `/v1/jobs`, `/v1/render`, `/v1/auth/*`). Gated by auth middleware with loopback bypass.

2. **CLI TCP server** (`127.0.0.1:3099`) — legacy JSON-over-TCP for CLI commands (`status`, `add_job`, `get_jobs`, `stop`). Still used by commands that haven't migrated yet; being phased out in favor of the REST API.

### Transports, services, jobs

Business logic lives in `internal/services/` (jobs, render, auth/apikeys, device flow). Transports (TCP, REST, future MCP) are thin adapters over those services. The in-memory queue + `Job` struct live in `internal/jobs/` so the services layer doesn't create an import cycle with `internal/server/`. See `docs/CLOUD_ROADMAP.md` for the full migration plan.

### Auth model

Two trust domains on the HTTP server:

- **User/agent** (`/v1/*`) — bearer token in `Authorization` header. Validated by `services.APIKeys.Verify` (SHA-256 lookup). Loopback requests **without** a header receive a synthetic `loopback / local / admin` identity (preserves today's local UX); loopback requests **with** a header are validated normally. `--require-auth` disables the header-less bypass.
- **Printer** (`/`) — separate trust domain. Today: unauthenticated. Step 8 adds per-printer HTTP Basic.

API keys: `rd_live_<24 hex>` format, 12-char public prefix (`rd_live_a731`) kept in plaintext in the DB for display, SHA-256 hash used for lookup. Scopes: `jobs:write`, `jobs:read`, `render`, `printers:read`, `printers:write`, `keys:write`, `admin`.

Device flow (RFC 8628): `POST /v1/auth/device/code` → poll `POST /v1/auth/device/token` → admin approves via `POST /v1/auth/device/approve`. CLI: `receiptd login`. Cached credential at `~/.receiptd/auth.json` (chmod 600).

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

**Text / Star Markup path (local / TCP)**:
```
receiptd print "text"
  → CLI client sends JSON to :3099 (internal/client TCP mode)
  → daemon.handleCLIConn → daemon.AddJob → services.Jobs.Create
  → Queue.Add (internal/jobs.Queue) + db.SaveJob
  → Star printer polls, GETs, cputil converts markup → binary, printer DELETEs
```

**Text / Star Markup path (remote / HTTP)**:
```
receiptd --api https://api.example.com --api-key rd_live_… print "text"
# or: RECEIPTD_API=… RECEIPTD_API_KEY=… receiptd print "text"
# or: after `receiptd login`, cached auth.json is auto-resolved
  → CLI client POSTs /v1/jobs with Authorization: Bearer … (internal/client HTTP mode)
  → auth middleware: APIKeyVerifier.Verify → services.APIKeys.Verify (SHA-256 DB lookup)
  → Identity attached to request context
  → APIHandler.handleJobsCollection → services.Jobs.Create → Queue.Add + db.SaveJob
  → CloudPRNT delivery same as TCP path
```

### Job sequencing

The Star printer fires two rapid polls per job: one immediately after GET (while still printing — ignored by the server) and one immediately after DELETE (printer is ready — server dispatches next job). `TakeNextJob()` in `internal/jobs/queue.go` enforces this atomically:

- Job is `processing` → return nil (post-GET poll; printer is still printing)
- Job is `acknowledged` (DELETE received) → finalize to `completed`, then give next pending job (post-DELETE poll; printer is ready)

### Key files

**Transports / server:**
- `internal/server/daemon.go` — `Daemon` struct orchestrates the HTTP + TCP servers; constructs all services; `Config.Verifier` + `Config.RequireAuthOnLoopback` control auth; `AddJob()` is a thin pass-through to `services.Jobs.Create`
- `internal/server/cloudprnt.go` — CloudPRNT HTTP handler (`/`); `convertToStarPRNT()` calls cputil; `handleGetJob()` prepends `[image: url file://...]` when `job.ImagePath` is set
- `internal/server/api.go` — REST v1 handlers (`/v1/*`); thin adapters over the services layer
- `internal/server/auth.go` — bearer-token middleware, `Identity`, `TokenVerifier` interface, loopback-bypass logic
- `internal/server/apikey_verifier.go` — adapter wrapping `services.APIKeys` as a `TokenVerifier` (kept in server package to avoid cycles)

**Services (business logic — no transport concerns):**
- `internal/services/jobs.go` — `Jobs.Create/Get/List`; appends `[feed:3][cut]` in `Create`, persists to DB
- `internal/services/render.go` — `Render.HTMLToPNG` wraps chromedp
- `internal/services/auth.go` — `APIKeys.Mint/Verify/List/Revoke`; SHA-256 hashing, `rd_live_` / `rd_test_` prefixes
- `internal/services/device_flow.go` — `DeviceFlow.Start/Poll/Approve` implementing RFC 8628

**Jobs / queue:**
- `internal/jobs/queue.go` — thread-safe in-memory job queue + `Job` struct + status constants; `TakeNextJob()` is the atomic gate for job sequencing

**Persistence:**
- `internal/db/db.go` — SQLite open + schema init (jobs, printers, api_keys, device_codes)
- `internal/db/jobs.go` / `printers.go` / `apikeys.go` / `device_codes.go` — DAO methods

**Render / image:**
- `internal/render/render.go` — `HTMLToPNG(html, width)` renders HTML via headless Chrome to a PNG at printer width (576px); `SaveRender()` persists to `~/.receiptd/renders/`
- `internal/imageproc/` — image-processing pipeline: `process.go` (public `Process()` API + `Options`/`Algorithm` types), `adjust.go` (brightness/contrast/gamma/grayscale), `dither.go` (threshold, Floyd-Steinberg, Atkinson, Bayer via dither/v2; Hilbert and blue-noise ported from photo-receipts)

**CLI:**
- `internal/client/client.go` — TCP **and** HTTP transports; `NewClient()` uses `RECEIPTD_API`, `NewClientFromConfig` takes explicit `ClientConfig`; HTTP mode hits `/v1/*` with a bearer header
- `internal/cli/root.go` — `--json`, `--verbose`, `--api`, `--api-key` persistent flags; `NewClient()` helper that resolves flags + env + cached `~/.receiptd/auth.json`
- `internal/cli/auth.go` — `login` (device flow polling loop), `logout`, `whoami`, `auth keys create/list/revoke`, `httpGET/POST` helpers
- `internal/cli/auth_state.go` — `~/.receiptd/auth.json` read/write helpers; `ResolvedAPIURL` / `ResolvedAPIKey` implement the resolution chain
- `internal/cli/server.go` — `server`, `server stop`, `--require-auth` flag
- `internal/cli/print.go` — `print` command; `--render` claims stdin before message reader to avoid conflict; `--image` and `--render` are mutually exclusive; falls back to `ErrorExit` in HTTP mode (no auto-start)
- `internal/cli/render.go` — standalone `render` subcommand for previewing HTML before printing
- `internal/cli/proc_flags.go` — shared `--dither`, `--brightness`, `--contrast`, `--gamma` flags registered on both `print` and `render` commands
- `internal/cli/font_flags.go` — shared `--font` flag registered on `render`, `print`, `lib run`, `lib preview`
- `internal/cli/fonts.go` — `receiptd fonts` subcommands (list, info, install, add, remove)
- `internal/fontlib/` — font registry and tooling: `fontlib.go` (Font struct, All/Lookup/Installed), `inject.go` (InjectFont — injects @font-face CSS before Chrome render), `install.go` (Install/Add/Remove), `bitmap_fonts.go` (6 receipt-optimized fonts), `fun_fonts.go` (10 fun/specialty fonts)
- `internal/stub/stub.go` — mock data stubs still used by a few CLI commands (jobs list display, status)

### Star Markup / cputil

Job content is treated as **Star Markup** (`.stm` format). The CloudPRNT handler shells out to `cputil` (from the Star CloudPRNT SDK) to convert markup → StarPRNT binary. `resolveCputilPath()` in `cloudprnt.go` finds it in priority order:

1. `$CPUTIL_PATH` env var
2. `cputil` on `$PATH`

If neither resolves, the server fails at startup with a clear error. Set `CPUTIL_PATH` in `.env` at the project root — it's loaded automatically at startup via `loadDotEnv()` in `main.go`. Note that the whole `cputil-bin/` directory must remain intact alongside the binary — it loads support files from its own directory at runtime.

Star Markup syntax: `[align: center]`, `[bold: on]`/`[bold: off]`, `[col: left X; right Y]`, `[feed]`, `[cut]`. Full tag reference: https://star-m.jp/products/s_print/sdk/StarDocumentMarkup/manual/en/tag-reference/index.html. `AddJob()` always appends `[feed:3][cut]` — callers must not include `[cut]` themselves. cputil conversion is required; a cputil error returns HTTP 500.

### HTML rendering / `--render`

`internal/render/render.go` wraps `chromedp` to launch headless Chrome and take a full-page PNG screenshot:

- **Output is binary black/white** — gray values either drop out or print solid; use dithering (`--dither floyd-steinberg`) for gradients/photos, and keep HTML purely black-on-white
- Viewport width: **576px** (80mm at 203 DPI — matches printer paper)
- Viewport height: **1px** initially, so Chrome's root element doesn't stretch; `FullScreenshot` expands to actual content height
- Flags: `--headless`, `--no-sandbox`, `--disable-gpu`, `--password-store=basic`, `--use-mock-keychain` (suppresses macOS Keychain dialog)
- Rendered PNGs saved to `~/.receiptd/renders/<timestamp>.png`
- Requires Chrome or Chromium installed; `requireChrome()` in integration tests skips gracefully if absent

### Data / config

- Server data directory: `~/.receiptd/`
- Log file: `~/.receiptd/receiptd.log`
- SQLite database: `~/.receiptd/receiptd.db` — jobs, printers, api_keys, device_codes. Pending jobs recovered on restart
- Rendered PNGs: `~/.receiptd/renders/`
- CLI cached credentials: `~/.receiptd/auth.json` (chmod 600, written by `receiptd login`, cleared by `receiptd logout`)
- `.env` at project root is loaded at startup (shell env takes precedence)

### Exit codes

- `0` — Success
- `1` — General error
- `2` — Server not running
- `3` — Printer error
- `4` — Configuration error

### Stub vs real implementation

A few CLI commands (`jobs`, `status`, some `printer` subcommands) still call `internal/stub/stub.go` instead of hitting the daemon. Production commands (`print`, `render`, `renders`, `lib run`, auth commands) use the real client. When wiring up a stub command to the real server, replace `stub.Foo()` with `cli.NewClient().Foo()` (the CLI-local wrapper that honors `--api`/`--api-key` and cached auth state).

### Cloud migration status

The work in progress to take receiptd multi-tenant is documented in `docs/CLOUD_ROADMAP.md`. Done so far: Steps 1–5 (REST API, services layer carve-out, auth middleware, CLI HTTP transport, API keys + OAuth device flow). Next up: Step 6 (multi-tenant data model — users, per-user printers), Step 7 (Fly.io deploy), Step 8 (printer pairing UX), Step 9 (MCP transport, deferred).
