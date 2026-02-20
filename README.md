# receiptd

> Agent-native thermal printing platform for Star/Epson thermal printers.

receiptd is a Go-based backend server that provides a modern REST API for thermal receipt printing via Star's CloudPRNT protocol. Designed for agents and applications that need reliable, authenticated print jobs with full printer management.

[![Go Version](https://img.shields.io/github/go-mod/go-version/chasebro/receiptd)](https://github.com/chasebro/receiptd)
[![License](https://img.shields.io/github/license/chasebro/receiptd)](LICENSE)

## Features

- **RESTful API** — Full print job, printer, and user management
- **JWT Authentication** — Secure access with role-based permissions (admin/operator/viewer)
- **CloudPRNT Protocol** — Native Star printer compatibility (TSP100IV, TSP143, etc.)
- **MQTT Support** — Push-based printing via MQTT broker
- **SQLite Database** — Embedded, no external dependencies
- **Markdown to Star Markup** — Simple print content format
- **Multi-format Support** — StarPL, markdown, PNG/image printing

## Architecture

```
receiptd/
├── cmd/server/          # Entry point
├── internal/
│   ├── config/          # Configuration management
│   ├── models/          # Data models (User, Printer, Job)
│   ├── storage/         # SQLite repository layer
│   ├── services/        # Business logic
│   ├── handlers/        # HTTP handlers
│   ├── middleware/      # Auth, RBAC, CORS
│   └── utils/           # Helpers
├── pkg/print/           # Print conversion utilities
├── migrations/          # Database migrations
└── config.yaml          # Configuration
```

## Quick Start

### Prerequisites

- Go 1.21+
- SQLite (included via modernc.org/sqlite)

### Install

```bash
git clone https://github.com/chasebro/receiptd.git
cd receiptd
go mod download
cp config.yaml.example config.yaml
# Edit config.yaml with your settings
go run cmd/server/main.go
```

### Configuration

```yaml
server:
  host: "0.0.0.0"
  port: 3000
  data_dir: "~/.receiptd/data"

database:
  path: "~/.receiptd/data/receiptd.db"

auth:
  jwt_secret: "change-me-in-production"
  token_expiry: 24h

mqtt:
  enabled: true
  broker: "localhost"
  port: 1883

printers:
  auto_register: true
  default_width: 80
```

### First Run

The server creates an admin user on first startup:

- **Username:** `admin`
- **Password:** `admin123`

> ⚠️ Change this password immediately in production!

## API Overview

### Authentication

```bash
# Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# Response
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 86400,
  "user": { "id": "...", "username": "admin", "role": "admin" }
}
```

### Print Jobs

```bash
# Submit a print job
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "printerId": "0011625aa98b",
    "content": "[align:center]Hello World[cut]",
    "format": "starpl",
    "options": { "cut": true, "padding": 3 }
  }'
```

### PrintBooth Markdown

receiptd supports a simple markdown-like syntax that converts to Star markup:

| Markdown | Output |
|----------|--------|
| `**bold**` | Bold text |
| `__underline__` | Underlined text |
| `[align:center]` | Center align |
| `[align:right]` | Right align |
| `[cut]` | Full cut |
| `[partialcut]` | Partial cut |
| `[feed:3]` | Feed 3 lines |

Example:
```markdown
**[align:center]RECEIPT**
---
Item 1 ...... $10.00
Item 2 ...... $15.00
---
**Total ...... $25.00**

[align:center]Thank you![cut]
```

## Printer Support

Tested with:
- Star TSP100IV
- Star TSP143III
- Star TSP143IV

Other CloudPRNT-capable Star printers should work.

## MQTT Topics

When MQTT is enabled, receiptd uses these topics:

| Topic | Direction | Description |
|-------|-----------|-------------|
| `star/cloudprnt/to-device/{mac}/print-job` | → Printer | Print job payload |
| `star/cloudprnt/from-device/{mac}/client-status` | ← Printer | Status update |
| `star/cloudprnt/from-device/{mac}/print-result` | ← Printer | Job completion |

## Role-Based Access

| Action | Admin | Operator | Viewer |
|--------|:-----:|:--------:|:------:|
| Manage users | ✓ | ✗ | ✗ |
| Manage printers | ✓ | ✓ | ✗ |
| Submit print jobs | ✓ | ✓ | ✗ |
| View jobs/printers | ✓ | ✓ | ✓ |
| Server administration | ✓ | ✗ | ✗ |

## Development

### Running Tests

```bash
go test ./...
```

### Database Migrations

```bash
# Create new migration
golang-migrate create -ext sql -dir migrations add_users_table

# Run migrations up
golang-migrate -path migrations -database sqlite:///data/receiptd.db up

# Run migrations down
golang-migrate -path migrations -database sqlite:///data/receiptd.db down
```

### Code Structure

- `internal/models/` — Data structures
- `internal/storage/` — Database repositories
- `internal/services/` — Business logic
- `internal/handlers/` — HTTP endpoints
- `internal/middleware/` — Auth & RBAC
- `pkg/print/` — Print format conversion

## License

MIT License — see [LICENSE](LICENSE) for details.

## Acknowledgments

- [Star Micronics](https://www.starmicronics.com/) for CloudPRNT
- [modernc.org](https://modernc.org/sqlite/) for pure Go SQLite