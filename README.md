# receiptd

> The thermal printing CLI for humans and agents.

receiptd is a self-hosted thermal printing CLI. Run `receiptd print "hello"` and get a receipt. No config files, no cloud account — just printing.

**⚡ Status**: Working! Tested with Star TSP100IV.

Designed for:
- **Home use** — A few prints a day (receipts, labels, notes)
- **Small business** — Kitchens, shops, cafes — low-volume thermal printing
- **Agents** — AI agents can call `receiptd` directly via CLI

[![Go Version](https://img.shields.io/github/go-mod/go-version/chasebro/receiptd)](https://github.com/chasebro/receiptd)
[![License](https://img.shields.io/github/license/chasebro/receiptd)](LICENSE)

## Quick Start

```bash
# Build
go build -o receiptd ./cmd/receiptd

# Print — server starts automatically on first use
./receiptd print "Hello, World!"

# With Star markup formatting
./receiptd print "[bold:on]HELLO[bold:off]"
```

## Features

- **Auto-start server** — Server starts automatically on first print
- **CLI-first** — Single binary, subcommands
- **CloudPRNT** — Native Star printer support (TSP100IV, TSP143, etc.)
- **Star Markup** — `[bold:on]`, `[align:center]`, `[cut]`, etc.
- **cputil integration** — Converts markup to StarPRNT binary
- **Logging** — Logs to `~/.receiptd/receiptd.log`

## Print Syntax

| Syntax | Description |
|--------|-------------|
| `[bold:on]` / `[bold:off]` | Bold text |
| `[align:center]` | Center align |
| `[align:left]` | Left align |
| `[align:right]` | Right align |
| `[cut]` | Cut paper |
| `[feed:n]` | Feed n lines |

Example:
```
[bold:on]RECEIPT[bold:off]
[align:center]
---
Item 1 ...... $10.00
---
[align:right]Total: $10.00[cut]
```

## Architecture

```
receiptd/
├── cmd/receiptd/main.go    # CLI entry
├── internal/
│   ├── cli/                 # Cobra commands
│   ├── client/              # CLI ↔ server comms
│   ├── server/
│   │   ├── daemon.go       # Main server
│   │   ├── cloudprnt.go    # CloudPRNT protocol
│   │   └── queue.go        # Job queue
│   └── stub/               # Stub implementations
```

## CloudPRNT Protocol

1. Printer polls `POST /cloudprnt` → Server returns job token
2. Printer fetches `GET /cloudprnt?token=X` → Server returns StarPRNT binary
3. Printer prints and sends `DELETE /cloudprnt?token=X` → Job complete

## Configuration

- Server port: 3000 (CloudPRNT), 3099 (CLI)
- Data dir: `~/.receiptd/`
- Log file: `~/.receiptd/receiptd.log`

## For Agents

```bash
# Just print — server auto-starts, no sleep needed
./receiptd print "[bold:on]ORDER #123[bold:off]"
```

## License

MIT — see [LICENSE](LICENSE).
