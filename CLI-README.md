# receiptd CLI Implementation

A **CLI-first**, **agent-friendly** thermal receipt printer daemon and command-line interface.

## 🎯 Design Philosophy

This implementation follows a **"design the CLI first, work backwards"** approach:

1. **CLI defines the UX** — Commands and flags demonstrate the intended workflow
2. **Stubs show what's possible** — Each command has working stub implementations
3. **Real backend comes later** — TODOs mark where actual implementation goes

## 🚀 Quick Start

```bash
# Build
make build

# Try it out (all stubs work!)
./receiptd status
./receiptd printer list
./receiptd print "Hello, World!"
./receiptd --json status

# See all commands
./receiptd --help

# Run demo
make demo
```

## 📋 Commands

### Server Management

```bash
# Start daemon
receiptd server

# Stop daemon
receiptd server stop

# Check health
receiptd status
receiptd --json status  # Agent-friendly JSON output
```

### Printing

```bash
# Print to default printer
receiptd print "Hello, World!"

# Print to specific printer
receiptd print --printer tsp100-kitchen "Order #42"

# Delayed print
receiptd print --wait 5 "Print in 5 seconds"
```

### Printer Management

```bash
# Discover printers on network
receiptd printer discover

# List configured printers
receiptd printer list
receiptd --json printer list

# Show printer details
receiptd printer show tsp100-kitchen

# Set default printer
receiptd printer default tsp100-kitchen
```

### Job Management

```bash
# List print jobs
receiptd jobs
receiptd --json jobs
```

### Configuration

```bash
# Show configuration
receiptd config show

# Set config value
receiptd config set default_printer tsp100-kitchen
receiptd config set log_level debug
```

## 🤖 Agent-Friendly Design

Every command supports `--json` for structured output:

```bash
receiptd --json status
```

```json
{
  "running": true,
  "uptime": "2h 15m",
  "version": "0.1.0",
  "printers_configured": 2,
  "printers_online": 1,
  "jobs_queued": 0,
  "jobs_processing": 1
}
```

### Clear Error Messages

Errors are designed to be actionable for both humans and agents:

- **No printer configured** → `"No printer configured. Run 'receiptd printer discover'"`
- **Server not running** → `"Server not running. Run 'receiptd server'"`
- **Printer offline** → `"Printer offline: tsp100-kitchen"`

### Consistent Exit Codes

- `0` — Success
- `1` — General error
- `2` — Server not running
- `3` — Printer error
- `4` — Configuration error

## 🏗️ Architecture

### Project Structure

```
receiptd/
├── cmd/
│   └── receiptd/
│       └── main.go          # Entry point
├── internal/
│   ├── cli/                 # Cobra command implementations
│   │   ├── root.go         # Root command + JSON helpers
│   │   ├── server.go       # Server start/stop
│   │   ├── status.go       # Health check
│   │   ├── print.go        # Print commands
│   │   ├── printer.go      # Printer management
│   │   ├── jobs.go         # Job listing
│   │   └── config.go       # Configuration
│   ├── client/             # Server communication (stub)
│   │   └── client.go
│   └── stub/               # Mock implementations
│       └── stub.go         # Returns example data
├── go.mod
├── Makefile
└── README.md
```

### Communication Design

The CLI will communicate with the server daemon via:

**Primary**: Unix socket at `~/.receiptd/receiptd.sock`  
**Fallback**: TCP on `127.0.0.1:3099`  

**Alternative**: CLI spawns server as child process for "it just works" UX

### Configuration

Configuration stored in `~/.receiptd/config.yaml`:

```yaml
default_printer: tsp100-kitchen
socket_path: ~/.receiptd/receiptd.sock
tcp_port: 3099
log_level: info
auto_discover: true
```

## 🔧 Implementation Roadmap

Each command file has `// TODO:` comments showing where real implementation goes:

### Phase 1: Core Infrastructure
- [ ] Implement `internal/client/client.go` — server communication
- [ ] Implement server daemon (separate process)
- [ ] Unix socket + TCP server
- [ ] Configuration loading/saving

### Phase 2: Printer Support
- [ ] Printer discovery (mDNS, network scan)
- [ ] Star TSP100IV integration
- [ ] CloudPRNT protocol support
- [ ] Printer status monitoring

### Phase 3: Job Management
- [ ] Job queue system
- [ ] Job persistence
- [ ] Retry logic
- [ ] Job history

### Phase 4: Polish
- [ ] Comprehensive error handling
- [ ] Logging system
- [ ] Health checks
- [ ] Auto-reconnect
- [ ] Graceful shutdown

## 📊 Current Status

**✅ Working now:**
- All CLI commands implemented with stubs
- JSON output for all commands
- Human-friendly formatting
- Help text and documentation
- Compiles and runs
- Clear UX demonstration

**🚧 Needs implementation:**
- Actual server daemon
- Real printer communication
- Persistent configuration
- Job queue
- Network discovery

## 🎨 Design Decisions

### Why Cobra?
- Most popular Go CLI framework
- Excellent help generation
- Subcommand support
- Flag parsing
- Shell completion

### Why Unix Socket + TCP?
- Unix socket: Fast, secure, local-only
- TCP fallback: Works everywhere, easier debugging
- Flexibility for different deployment scenarios

### Why JSON Output Flag?
- Agents need structured data
- Humans want pretty output
- Single binary serves both use cases
- Easy to parse in any language

### Why Stubs First?
- Demonstrates complete UX before backend complexity
- Easy to test CLI ergonomics
- Clear contract for server implementation
- Can refine interface without breaking changes
- Fast iteration on design

## 🔨 Development

```bash
# Build
make build

# Install to /usr/local/bin
make install

# Run demo of all commands
make demo

# Clean build artifacts
make clean
```

## 📝 Examples

### For Humans

```bash
$ receiptd print "Order #42 ready!"
🖨️  Printing message...
   Printer: tsp100-kitchen (default)
   Job ID: job-1708435200

✅ Print job submitted successfully
   Track with: receiptd jobs
```

### For Agents

```bash
$ receiptd --json print "Order #42 ready!"
{
  "job_id": "job-1708435200",
  "printer_id": "tsp100-kitchen",
  "message": "Order #42 ready!",
  "status": "queued"
}
```

## 🚀 Next Steps

1. **Implement `internal/client/client.go`** — Real server communication
2. **Create server daemon** — Separate `cmd/receiptd-server` or embed in CLI
3. **Add printer drivers** — Star TSP100IV support via CloudPRNT
4. **Implement job queue** — Persistent, retryable job processing
5. **Add tests** — Unit tests for CLI, integration tests for full stack

## 📄 License

MIT

---

**Current version: 0.1.0-stub**  
All commands are functional stubs demonstrating the intended UX.  
Backend implementation in progress.
