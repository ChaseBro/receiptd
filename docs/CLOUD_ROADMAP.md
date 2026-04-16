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
Dockerfile bundling the binary + `cputil-bin/` + headless Chrome (chromedp/headless-shell base or similar). `fly launch`. Persistent SQLite on a Fly Volume. HTTPS via Fly's default cert. After this step, `receiptd login --api https://api.receiptd.app` works end-to-end from any machine.

### Step 8 — Printer pairing UX
Minimal web page (Go templates, served by the same binary) or CLI-only flow. Pair a printer → get the CloudPRNT URL + Basic-auth secret to paste into the printer's web config. Existing local users who want cloud mode can re-pair an existing printer.

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

- Cloudflare Workers, D1, R2, Containers, Browser Rendering
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
