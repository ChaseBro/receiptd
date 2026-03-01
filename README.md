# receiptd

> The thermal printing CLI for humans and agents.

receiptd is a self-hosted thermal printing CLI. Run `receiptd print --render '<html>...'` and get a receipt. No config files, no cloud account — just printing.

**⚡ Status**: Working! Tested with Star TSP100IV.

Designed for:
- **Home use** — A few prints a day (receipts, labels, notes)
- **Small business** — Kitchens, shops, cafes — low-volume thermal printing
- **Agents** — AI agents can call `receiptd` directly via CLI; HTML rendering means full emoji + layout support with no special printer knowledge

[![Go Version](https://img.shields.io/github/go-mod/go-version/chasebro/receiptd)](https://github.com/chasebro/receiptd)
[![License](https://img.shields.io/github/license/chasebro/receiptd)](LICENSE)

## Quick Start

```bash
# Build
go build -o receiptd ./cmd/receiptd

# Preview an HTML receipt (renders to PNG via headless Chrome)
./receiptd render --output preview.png '<html><body style="width:576px;font-size:20px">
  <h1>Hello 🎉</h1><p>It works!</p>
</body></html>'
open preview.png

# Print it — server starts automatically on first use
./receiptd print --render - < preview.html
```

## Features

- **HTML rendering** — Write HTML, get a receipt. Emojis, CSS, images, web fonts — all work via headless Chrome
- **Preview before printing** — `receiptd render --output preview.png` to see exactly what will print
- **Auto-start server** — Server starts automatically on first print, no manual setup
- **CLI-first** — Single binary, subcommands, pipes-friendly
- **CloudPRNT** — Native Star printer support (TSP100IV, TSP143, etc.)
- **SQLite persistence** — Jobs survive restarts and are recovered automatically
- **Star Markup** — `[bold:on]`, `[align:center]`, etc. for text-only prints

## Print with HTML (recommended)

```bash
# From a string
receiptd print --render '<html><body style="width:576px">...</body></html>'

# From a file or stdin
receiptd print --render - < receipt.html

# Preview first, then print
receiptd render --output /tmp/preview.png - < receipt.html
open /tmp/preview.png
receiptd print --render - < receipt.html
```

HTML is rendered at **576px wide** (80mm paper) via headless Chrome. Height is unconstrained — content flows as long as it needs to.

### Starter template

```html
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Courier New', monospace;
  font-size: 20px;
  width: 100%;           /* fills the 384px CSS viewport */
  background: white;
  padding: 12px 14px;
  box-sizing: border-box;
}
.center { text-align: center; }
.rule   { border-top: 2px solid #000; margin: 8px 0; }
.row    { display: flex; justify-content: space-between; }
</style></head><body>

<p class="center" style="font-size:32px;font-weight:bold">🧾 RECEIPT</p>
<div class="rule"></div>
<div class="row"><span>Item one</span><span>$10.00</span></div>
<div class="row"><span>Item two</span><span>$5.00</span></div>
<div class="rule"></div>
<div class="row"><strong>Total</strong><strong>$15.00</strong></div>
<div class="rule"></div>
<p class="center">Thank you! 🙏</p>

</body></html>
```

## Print with Star Markup (text-only)

For simple text layouts without emojis or images:

```bash
receiptd print '[bold:on]ORDER #123[bold:off]'
receiptd print '[align:center]Hello, World!'
```

Full Star Markup reference: [star-m.jp](https://star-m.jp/products/s_print/sdk/StarDocumentMarkup/manual/en/tag-reference/index.html)

## Print an image file

```bash
receiptd print --image /path/to/photo.png "optional caption"
```

## Architecture

```
receiptd/
├── cmd/receiptd/main.go    # Entry point; loads .env at startup
├── internal/
│   ├── cli/                # Cobra commands (print, render, server, status…)
│   ├── client/             # CLI ↔ server TCP/JSON comms
│   ├── render/             # HTML → PNG via headless Chrome (chromedp)
│   ├── server/
│   │   ├── daemon.go       # Orchestrates both servers, job lifecycle
│   │   ├── cloudprnt.go    # CloudPRNT protocol + cputil integration
│   │   └── queue.go        # Thread-safe in-memory job queue
│   ├── db/                 # SQLite persistence (jobs + printers)
│   └── stub/               # Stub implementations for unwired commands
└── skills/
    ├── print.md             # /print skill — HTML rendering
    ├── star-markup-print.md # /star-markup-print skill — text markup
    └── star-markup-template-design.md
```

## CloudPRNT Protocol

1. Printer polls `POST /` → Server returns job token
2. Printer fetches `GET /?token=X&type=application/vnd.star.starprnt` → Server returns StarPRNT binary
3. Printer prints and sends `DELETE /?token=X` → Job complete

## Configuration

- Data dir: `~/.receiptd/`
- Log file: `~/.receiptd/receiptd.log`
- SQLite DB: `~/.receiptd/receiptd.db`
- Rendered PNGs: `~/.receiptd/renders/`
- Ports: 3000 (CloudPRNT HTTP), 3099 (CLI TCP)
- `CPUTIL_PATH` — path to Star cputil binary; set in `.env` at project root

## For Agents

```bash
# Full emoji + layout support — no printer knowledge needed
receiptd print --render - <<'EOF'
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:monospace;font-size:20px;width:576px;padding:12px">
<h2 style="text-align:center">🤖 Agent Report</h2>
<p>Task completed at 3:42 PM</p>
<p>✅ 12 items processed</p>
<p>⚠️  2 warnings</p>
</body></html>
EOF
```

## License

MIT — see [LICENSE](LICENSE).
