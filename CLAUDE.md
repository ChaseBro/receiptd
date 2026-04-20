# CLAUDE.md

Guidance for Claude Code working in this repo. Cloud migration in progress — read `docs/CLOUD_ROADMAP.md` before making infra/auth changes.

## Commands

```bash
# Build + test
make build                                      # → ./receiptd
go test -v -count=1 ./...

# Run (local)
./receiptd server                               # foreground, Ctrl+C to stop
./receiptd server --require-auth                # cloud-mode simulation (bearer on loopback)
./receiptd server stop

# Print / render (core)
./receiptd print "[bold:on]Hello[bold:off]"                          # Star Markup text
./receiptd print --image photo.png "caption"
./receiptd render --output /tmp/p.png '<html>…'                      # preview before print
./receiptd renders list                                              # list saved renders
./receiptd renders print <id> --dither floyd-steinberg               # reprint with options

# Image / font flags (work on print + render)
--dither none|threshold|floyd-steinberg|atkinson|bayer|hilbert|blue-noise
--brightness -100..100  --contrast -100..100  --gamma 0.5..2.5
--font press-start-2p                           # bitmap font injected into HTML

# Remote / auth
./receiptd login --api https://api.example.com  # RFC 8628 device flow → ~/.receiptd/auth.json
./receiptd whoami                                # loopback | user | apikey
./receiptd logout
./receiptd auth keys create --label laptop --scope jobs:write --scope jobs:read
./receiptd auth keys list
./receiptd auth keys revoke rd_live_abcd

# --api / --api-key work on every command (env: RECEIPTD_API / RECEIPTD_API_KEY)
./receiptd --api https://api.example.com print "hello"
```

## Architecture

Single daemon, single HTTP server, two route trees on port 3000:

- **`/`** — CloudPRNT polling for Star printers (POST poll → GET job → DELETE ack). Unauthenticated today; per-printer HTTP Basic lands in Step 8.
- **`/v1/*`** — REST API for humans/agents. Bearer-token auth via middleware with loopback bypass (header-less loopback = admin; loopback with bearer = validated normally; `--require-auth` disables the shortcut).

A legacy TCP server at `127.0.0.1:3099` still handles some CLI commands; being phased out in favor of REST.

**Layering** (enforce: transports are thin adapters, logic lives in services):
- `internal/server/` — HTTP + TCP handlers, auth middleware, CloudPRNT protocol
- `internal/services/` — business logic: `Jobs`, `Render`, `APIKeys`, `DeviceFlow`
- `internal/jobs/` — in-memory `Queue` + `Job` struct (split out from server to break the services↔server import cycle)
- `internal/db/` — SQLite DAO (jobs, printers, api_keys, device_codes)
- `internal/client/` — CLI-side transport; TCP or HTTP based on `RECEIPTD_API`
- `internal/cli/` — Cobra commands; `cli.NewClient()` resolves `--api` → env → `~/.receiptd/auth.json`
- `internal/render/` — chromedp HTML→PNG at 576px (80mm × 203dpi)
- `internal/imageproc/` — dithering + adjust pipeline
- `internal/fontlib/` — 16-font registry + `@font-face` injection
- `internal/stub/` — mock data for a few CLI commands not yet wired to the server

## Auth model

- **API keys** — `rd_live_<24 hex>` (or `rd_test_`). DB stores SHA-256 hash; the 12-char prefix (`rd_live_a731`) is shown in listings. Scopes: `jobs:write`, `jobs:read`, `render`, `printers:read`, `printers:write`, `keys:write`, `admin`.
- **Device flow (RFC 8628)** — `POST /v1/auth/device/code` → CLI polls `POST /v1/auth/device/token` → admin approves `POST /v1/auth/device/approve`. On approval the service mints an API key and returns it once.
- **Printer** — separate trust domain on `/`; Step 8 will add per-printer HTTP Basic.

## Job flow

```
receiptd print "text"              TCP mode: CLI → :3099 → daemon.AddJob → services.Jobs.Create
                                   HTTP mode: CLI → POST /v1/jobs → auth → services.Jobs.Create
  → Queue.Add + db.SaveJob
  → printer POST polls / → daemon.takeNextJob returns job with token
  → printer GET / → cloudprnt.go prepends [image: url …] if ImagePath; cputil converts markup → StarPRNT binary
  → printer DELETE / → Queue finalizes "acknowledged" → "completed" on next poll
```

`services.Jobs.Create` always appends `[feed:3][cut]`. Callers must not include `[cut]` themselves.

## Star Markup + cputil

Job content is Star Markup (`.stm`). The CloudPRNT handler shells out to `cputil` (Star CloudPRNT SDK) for markup → StarPRNT binary conversion. Resolution order: `$CPUTIL_PATH` → `cputil` on `$PATH`. Fails at startup if unresolved. Set in project-root `.env` (loaded by `loadDotEnv()` in `main.go`). The `cputil-bin/` directory must stay alongside the binary — it loads support files from its own directory at runtime.

Tag reference: https://star-m.jp/products/s_print/sdk/StarDocumentMarkup/manual/en/tag-reference/index.html

## HTML rendering

`chromedp` headless Chrome at 576px viewport. Output is binary B&W — use `--dither floyd-steinberg` for gradients/photos; keep HTML purely black-on-white. Chrome flags include `--password-store=basic --use-mock-keychain` to suppress macOS Keychain dialogs. Rendered PNGs go to `~/.receiptd/renders/`.

## Data / config

- `~/.receiptd/` — data dir (db, log, renders, cached auth)
- `~/.receiptd/receiptd.db` — SQLite (jobs, printers, api_keys, device_codes); pending jobs recovered on restart
- `~/.receiptd/auth.json` — CLI cached credential (chmod 600), written by `login`
- `.env` at project root — loaded at startup (shell env wins)

## Exit codes

`0` success · `1` general error · `2` server not running · `3` printer error · `4` config error

<!-- stripe-projects-cli managed:claude-md:start -->
look at AGENTS.md for your rules
<!-- stripe-projects-cli managed:claude-md:end -->
