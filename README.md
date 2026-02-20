# receiptd

> The thermal printing CLI for humans and agents.

receiptd is a self-hosted thermal printing tool designed for simplicity. Plug in a Star printer, run `receiptd print "hello"`, get a receipt. No config files, no cloud account, no RBAC — just printing.

Designed for:
- **Home use** — A few prints a day (receipts, labels, notes)
- **Small business** — Kitchens, shops, cafes — low-volume thermal printing
- **Agents** — AI agents can call `receiptd` directly via CLI

[![Go Version](https://img.shields.io/github/go-mod/go-version/chasebro/receiptd)](https://github.com/chasebro/receiptd)
[![License](https://img.shields.io/github/license/chasebro/receiptd)](LICENSE)

## Features

- **Auto-discovery** — Finds Star printers on your network automatically
- **CLI-first** — Single binary, subcommands, no REST API complexity
- **CloudPRNT** — Native Star printer support (TSP100IV, TSP143, etc.)
- **MQTT ready** — Optional push-based printing via MQTT broker
- **SQLite** — Embedded database, no external dependencies
- **Agent-native** — Designed for AI agents to call directly
- **Self-hosted** — Runs on your network, your data stays local

## Supported Printers

- Star TSP100IV
- Star TSP143III
- Star TSP143IV
- Other CloudPRNT-capable Star printers

## Installation

```bash
# Install via Go
go install github.com/chasebro/receiptd@latest

# Or clone and build
git clone https://github.com/chasebro/receiptd.git
cd receiptd
go build -o receiptd ./cmd/receiptd
```

## Quick Start

```bash
# 1. Start the server (runs in background)
receiptd server

# 2. In another terminal, discover printers
receiptd printer discover

# 3. Print!
receiptd print "Hello, World!"
```

That's it. The first time you run `receiptd print`, it:
1. Starts the server if not running
2. Finds your printer (or uses the last one)
3. Sends the job
4. Returns

## Usage

### Print

```bash
# Simple print
receiptd print "Hello World"

# With Star markup
receiptd print "[align:center][bold:on]RECEIPT[bold:off][cut]"

# With markdown (auto-converted)
receiptd print "**[align:center]RECEIPT[cut]**"

# Target specific printer
receiptd print --printer 0011625aa98b "Hello"

# Wait for printer (useful in scripts)
receiptd print --wait 10 "Hello"
```

### Printer Management

```bash
# Discover printers on network
receiptd printer discover

# List known printers
receiptd printer list

# Show printer details
receiptd printer show 0011625aa98b

# Set default printer
receiptd printer default 0011625aa98b
```

### Server

```bash
# Start server (daemon mode)
receiptd server

# Check server status
receiptd status

# View recent jobs
receiptd jobs

# Stop server
receiptd server stop
```

### Configuration

```bash
# Show current config
receiptd config show

# Set options
receiptd config set mqtt.enabled true
receiptd config set printers.default_width 80
```

## Print Syntax

receiptd supports a simple markdown-like syntax:

| Syntax | Description |
|--------|-------------|
| `**bold**` | Bold text |
| `__underline__` | Underlined text |
| `[align:center]` | Center align |
| `[align:right]` | Right align |
| `[align:left]` | Left align |
| `[cut]` | Full cut (end of receipt) |
| `[partialcut]` | Partial cut |
| `[feed:3]` | Feed 3 lines |
| `[size:2x]` | Double-size text |
| `[inverse:on]` | White text on black |

### Example Receipt

```
**[align:center]RECEIPT**
[align:left]
---
Item 1 ...... $10.00
Item 2 ...... $15.00
---
[align:right]**Total: $25.00**

[align:center]Thank you![cut]
```

## How It Works

### Discovery

On first run (or `receiptd printer discover`), receiptd uses mDNS/Bonjour to find Star CloudPRNT printers on your network. Found printers are saved to local SQLite — subsequent prints don't need to re-discover.

### Printing Flow

```
receiptd print "Hello"
       ↓
Server receives request (via Unix socket or localhost HTTP)
       ↓
Fetches printer from config
       ↓
Converts "Hello" → Star markup
       ↓
Queues job (SQLite)
       ↓
CloudPRNT: printer polls, server returns job
       ↓
Printer prints, confirms completion
       ↓
Job marked complete
```

### Server Mode

The server (`receiptd server`) runs as a daemon:
- Listens for print commands
- Serves CloudPRNT to connected printers
- Handles printer discovery
- Stores jobs and printer config in SQLite

The server is designed for **low volume** — a few prints per day. It sleeps between jobs and wakes quickly when needed. Not designed for high-throughput (hundreds of jobs/minute).

## Configuration

Default config location: `~/.receiptd/config.yaml`

```yaml
server:
  # Socket or port for CLI ↔ server communication
  socket: "~/.receiptd/receiptd.sock"
  # Or TCP (if socket doesn't work on your platform)
  host: "127.0.0.1"
  port: 3099

database:
  path: "~/.receiptd/receiptd.db"

printers:
  # Auto-discover on startup
  auto_discover: true
  # Default paper width (58 or 80mm)
  default_width: 80

mqtt:
  enabled: false
  broker: "localhost"
  port: 1883

cloudprnt:
  # Listen for printer connections
  listen: ":3000"
```

### Environment Variables

```bash
# Override port
RECEIPTD_PORT=3099 receiptd print "hello"

# Override data directory
RECEIPTD_DATA_DIR=/data receiptd status
```

## Architecture

```
receiptd/
├── cmd/receiptd/           # CLI entry point + subcommands
├── internal/
│   ├── config/             # Config loading
│   ├── discovery/           # mDNS/Bonjour printer discovery
│   ├── models/             # Printer, Job, Config structs
│   ├── storage/            # SQLite repository
│   ├── server/             # Daemon server (CloudPRNT)
│   └── print/              # Markup conversion
└── migrations/             # DB schema
```

## For Agents

receiptd is designed for AI agents to call directly. Agents should:

1. **Start the server if needed:**
   ```bash
   receiptd server &
   receiptd status  # wait for ready
   ```

2. **Print with defaults:**
   ```bash
   receiptd print "Your receipt content"
   ```

3. **Handle errors gracefully:**
   - "No printer found" → run `receiptd printer discover` first
   - "Server not running" → start with `receiptd server`

4. **Use `--wait` for reliability:**
   ```bash
   receiptd print --wait 15 "[bold:on]ORDER #123[bold:off][cut]"
   ```

## Troubleshooting

### Printer not found

```bash
# Manual discovery
receiptd printer discover

# Check printer is on and connected to network
# Verify firewall allows mDNS (port 5353)
```

### Print job stuck

```bash
# List jobs
receiptd jobs

# Check server logs
receiptd server logs

# Restart server
receiptd server restart
```

### Permission denied (socket)

```bash
# Use TCP instead of socket
receiptd config set server.socket ""
receiptd config set server.port 3099
```

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [Star Micronics](https://www.starmicronics.com/) for CloudPRNT
- [modernc.org](https://modernc.org/sqlite/) for pure Go SQLite