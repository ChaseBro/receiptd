# Cloud Roadmap

This document captures the plan to evolve `receiptd` from a local-only daemon into a multi-tenant cloud service without rewriting the codebase or breaking local users. Future iterations and agents should read this before making infra or auth changes.

## Guiding principle

**One Go binary, two deployment modes.** The same code that runs as `receiptd server` on a laptop today should run as `receiptd server --public` on a cloud host. Local mode is public mode with auth bypassed for loopback and SQLite at `~/.receiptd/`. No sibling folder, no language split, no flag-day rewrite.

Every step below is independently shippable and preserves today's local-daemon UX.

## Architecture target

```
[Agent / CLI / Skill on any machine]
        │ HTTPS, bearer token (or API key)
        ▼
[receiptd server --public on Fly.io]
        ├── /v1/jobs, /v1/render, ...     REST API (primary)
        ├── /cprnt/:printerId             CloudPRNT polling, HTTP Basic
        ├── /mcp                          MCP transport (deferred, step 9)
        └── /oauth/*                      Device flow + API key mgmt
        │
        ├── SQLite on Fly Volume          (same DB schema as local)
        ├── cputil bundled in image       (same binary as local)
        └── headless Chrome bundled       (same render path as local)
```

**Platform pick: Fly.io.** Keeps a single Go codebase. Ships the existing chromedp + cputil setup unchanged. Scale-to-zero, cheap, public HTTPS by default. Cloudflare Workers remains interesting but requires a TypeScript rewrite we're choosing not to take on.

## Auth model

Two paths, one CLI:

- **Humans → OAuth 2.0 Device Authorization Grant (RFC 8628)** — `receiptd login` opens a browser, user signs in, token cached in `~/.receiptd/auth.json`.
- **Agents → API keys** — `RECEIPTD_API_KEY=rd_live_...` env var. Scoped (`jobs:write`, `jobs:read`, `render`, etc.). Minted from the CLI or web UI. Individually revocable.

Token resolution per CLI invocation: `--api-key` flag → `RECEIPTD_API_KEY` env → `~/.receiptd/auth.json` → friendly error.

Printer auth is a separate trust domain: HTTP Basic on `/cprnt/:printerId` with per-printer secrets. Printers never see user tokens.

## Migration order

Each step is shippable on its own. Local users see no disruption until they opt into the new flow.

### Step 1 — REST API alongside TCP server
Add `internal/server/api.go` mounted on the existing HTTP server (port 3000). Endpoints: `POST /v1/jobs`, `GET /v1/jobs/:id`, `GET /v1/jobs`, `POST /v1/render`. Handlers are thin wrappers over the same `Queue` / `AddJob` code TCP uses today. TCP server untouched. Verify with `curl` + existing CLI still works.

### Step 2 — Services layer carve-out
Move business logic from TCP and HTTP handlers into `internal/services/`. `services.Jobs` (Create, Get, List), `services.Render`. Both transports become thin adapters. This is the foundation for every later step — especially MCP (step 9), which will be another thin adapter over the same services.

Rule for the rest of the project: **no business logic in handlers.**

### Step 3 — Auth middleware with loopback bypass
Bearer + API-key middleware on the HTTP API. `127.0.0.1` requests skip auth (preserves today's local UX). Public-mode requests always require it. Adds `~/.receiptd/auth.json` storage and a token resolution chain in the CLI. Still no cloud — fully testable locally by running `receiptd server` and hitting it from a non-loopback interface (or disabling the bypass via a flag).

### Step 4 — CLI `--api` / `RECEIPTD_API`
CLI picks transport based on env: local TCP (default) or remote HTTPS. Migrate `print` and `render` off TCP onto HTTP first; other commands follow as touched. TCP server deprecation happens naturally over time.

### Step 5 — Device-flow login + API keys
Implement RFC 8628 (~200 lines of Go). `receiptd login` / `logout` / `whoami`. API keys via `receiptd auth keys create|list|revoke`. Works against a local daemon first — same flow works later against the deployed one.

### Step 6 — Multi-tenant data model
New tables: `users`, `printers`, `api_keys`, `printer_secrets`. Existing single-user installs auto-migrate to a "default" user + default printer on first start. Job queue keyed by `printer_id`. CloudPRNT routes by `/cprnt/:printerId` with HTTP Basic validated against `printer_secrets`.

### Step 7 — Public deploy on Fly.io
Dockerfile bundling the binary + `cputil-bin/` + headless Chrome (chromedp/headless-shell base) + bitmap fonts. `fly launch`. Persistent SQLite on a Fly Volume. HTTPS via Fly's default cert. After this step, `receiptd login --api https://api.receiptd.sh` works end-to-end from any machine.

**Files (landed 2026-04-19):**
- `Dockerfile` — multi-stage: `golang:1.24-bookworm` build → `chromedp/headless-shell` runtime. `PATH=/headless-shell:$PATH` so the existing chromedp PATH lookup in `internal/render/render.go` finds Chrome with no code change. `HOME=/data`, `CPUTIL_PATH=/app/cputil-bin/cputil`. Runs `receiptd server --require-auth` under `tini`.
- `fly.toml` — 1 GB `shared-cpu-1x`, `receiptd_data` volume → `/data`, `internal_port=3000`, `auto_stop=stop` (scale-to-zero; the printer's CloudPRNT poll keeps it warm during use).
- `.dockerignore`, `.gitignore` entries for `/cputil-bin/` and `/fonts-seed/`.
- `Makefile` — `vendor-cputil` (extracts the Star SDK Linux tarball — proprietary, sourced from `$CPUTIL_TARBALL`), `vendor-fonts` (copies `~/.receiptd/fonts/*` into `./fonts-seed/`), `docker-build` (chains both and builds `linux/amd64`).

**Font-seeding design note:** fonts live at `$HOME/.receiptd/fonts`, but `HOME=/data` is the Fly volume mount point — anything baked into that path in the image is shadowed at runtime. So fonts ship in `/app/fonts-seed/` and a small `/app/entrypoint.sh` runs `cp -n /app/fonts-seed/* $HOME/.receiptd/fonts/` before `exec`ing the server. `-n` preserves any user-added fonts on the volume. Same trick would apply to any other seed data that needs to live on the volume.

Smoke-tested 2026-04-19: Press Start 2P, Spleen 8×16, Alagard all rendered cleanly inside the container; Floyd-Steinberg dither on a black→white gradient verified `internal/imageproc` runs fine alongside chromedp.

**Deployed 2026-04-21** via Stripe Projects (`stripe projects env --pull` → `FLYIO_DEPLOY_TOKEN` in `.env`; `flyctl` reads `FLY_API_TOKEN="FlyV1 $FLYIO_DEPLOY_TOKEN"`). App name `receiptd` in `iad`, custom hostname `api.receiptd.sh` (Let's Encrypt cert via Fly). End-to-end reachable (401 from `/v1/healthz` without a token is the expected auth-required response).

### Step 7b — CloudPRNT edge proxy (Cloudflare Worker)

**Status (2026-04-21): live in production.** Worker `receiptd-cprnt` deployed to CF; custom domain `cprnt.receiptd.sh` serving (200 OK); KV `receiptd-cprnt-receiptd_jobs` + R2 `receiptd-jobs` bound; HMAC shared with Fly (`FLY_HMAC_SECRET` on worker, `RECEIPTD_WORKER_HMAC_SECRET` + `RECEIPTD_WORKER_URL` on Fly). See `worker/` for the Hono app and `internal/cloudcprnt/` for the Fly-side client.

Decided 2026-04-20 before first Fly deploy. The scale-to-zero story on Fly
alone is broken: the printer polls every 5–60 s, so the Fly machine never
idles and we pay ~$5/mo per printer for 99.9% no-op responses. Splitting the
CloudPRNT surface onto a Cloudflare Worker fixes this without a CF rewrite
of the whole app.

**Shape:**

```
printer  → cprnt.receiptd.sh     → CF Worker + KV + R2    (handles all polls)
                                        │
CLI/API  → api.receiptd.sh       → Fly (Go, unchanged)
                                        │
                                        └── on job create:
                                              • render HTML → PNG
                                              • cputil markup → StarPRNT binary
                                              • PUT binary → R2
                                              • SET KV: "job ready for printer X"
```

**Runtime flow:**
- Printer POSTs poll → Worker reads `KV:printer:<id>:job` → returns
  `{jobReady: false}` 99.9% of the time. Fly stays asleep.
- When a job is queued: Worker returns `{jobReady: true, mediaTypes: ...}`.
  Printer GETs → Worker streams directly from R2 (still no Fly touch).
  Printer DELETEs → Worker updates KV, optionally fires a webhook to Fly
  for completion accounting.
- Fly only wakes when a human/agent creates a job (CLI → `POST /v1/jobs`),
  so `auto_stop_machines = "stop"` actually works. Idle cost: near zero.

**Scope (~2 days):**
- New: `worker/` TypeScript project (~200 lines), Hono or bare Workers.
- CF resources: KV namespace `receiptd_jobs`, R2 bucket `receiptd_jobs`.
- Signing: Fly signs `R2 upload URL + KV write` with a shared secret;
  Worker verifies on read. Or: Fly uses a scoped R2 token; Worker uses a
  read-only token. No Worker-side auth needed for printer polls beyond
  HTTP Basic on `cprnt.receiptd.sh/cprnt/:printerId`.
- Fly code change: after `services.Jobs.Create` renders/converts, PUT to R2
  and POST to Worker admin endpoint (or write KV directly via CF API) to
  mark job ready. Delete on ack.

**What stays on Fly:**
- REST API (`/v1/*`), device flow, render pipeline, cputil.
- SQLite DAO and auth store (`internal/db/`, `internal/services/*`).
- No Go code rewrite; Fly remains the single source of truth for job state.
  KV is a cache/signal, not authoritative.

**What's NOT on CF:** chromedp rendering, cputil subprocess, dithering. Those
stay on Fly — CF Browser Rendering + a Container is still too much surface
for their benefit at this scale.

**Printer status capture (landed 2026-04-20):** each poll parses
`printerMAC`, `statusCode`, `printingInProgress`, and the `clientAction[]`
entries (PageInfo / ClientType / ClientVersion) into `KV:printer:<id>:status`.
Writes are gated by change-detection + a 60-second liveness heartbeat, so a
5-second poll cadence costs ~1 KV read per poll and ~1 KV write per minute at
steady state (well inside the paid tier). Fly reads the snapshot via signed
`GET /admin/printers/:id/status`; no push path required.

### Step 8 — Printer pairing UX

**TSP100IV web UI is fully scriptable** (learned 2026-04-20 by probing 192.168.1.38 directly — form auth + cookie-gated CGI POSTs, no CSRF). `receiptd printer pair --ip --admin-pass --label` logs in via `/auth/form_authentication.cgi`, POSTs config to `/html/cloudprnt_cgi`, triggers save+restart via `/html/save_cgi`. See `internal/printerconfig/`. Zero manual paste needed. Pasteable fallback still emitted if the LAN push fails.

### Step 9 — MCP transport (deferred)
Bolt on `/mcp` using `mark3labs/mcp-go` or the official Anthropic Go MCP SDK. Tools wrap the same `services/` calls. Reuse the OAuth provider from step 5. Expected effort: ~1 day because step 2 did all the structural work.

Defer until the REST API + CLI story is stable and we've learned what tools agents actually want.

## Design commitments that cost nothing now, save a week later

1. **Services layer** (step 2) — no business logic in handlers. Non-negotiable.
2. **OAuth 2.1 from day 1** (step 5) — the MCP spec requires OAuth 2.1 + PKCE. Adding it later is a rewrite of the auth model.
3. **Zod-equivalent input validation at the service boundary** — Go struct tags + go-playground/validator. Same validation regardless of transport.
4. **Stable resource IDs in URLs** — never session-scoped state.
5. **Idempotency keys on `createJob`** — agents retry; MCP clients retry more.

## Out of scope until proven necessary

- Cloudflare D1, Containers, Browser Rendering (Workers + KV + R2 are in scope
  as of step 7b; the rest stays on Fly)
- Postgres / libSQL (SQLite + Fly Volume is fine until it isn't)
- Web UI beyond the pairing page
- Mobile apps / browser extensions
- Anything multi-region

## For agents picking up this work

- Read this doc first, then check `MEMORY.md` for latest context.
- Work in task-list order. Don't skip steps 1–2; they're the foundation.
- Preserve the local-daemon UX at every step. No flag-day migrations.
- When in doubt, the answer is "keep the Go binary single, add a mode flag, don't fork into a sibling."
- MCP is additive, not a rewrite. Don't design around it prematurely, but don't design in ways that block it.
