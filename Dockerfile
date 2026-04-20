# syntax=docker/dockerfile:1.7

# --- build stage -------------------------------------------------------------
FROM golang:1.24-bookworm AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" \
    -o /out/receiptd ./cmd/receiptd

# --- runtime stage -----------------------------------------------------------
# chromedp/headless-shell ships a pinned headless Chrome on Debian bookworm.
# The binary lives at /headless-shell/headless-shell; we add that dir to PATH
# so chromedp's PATH-based lookup in internal/render/render.go picks it up.
FROM chromedp/headless-shell:latest

ENV PATH="/headless-shell:${PATH}" \
    HOME="/data" \
    CPUTIL_PATH="/app/cputil-bin/cputil"

# Fonts + CA roots + tini (PID 1). ca-certificates is needed for outbound HTTPS
# (e.g. device-flow callbacks); fonts-liberation avoids □ boxes in rendered HTML.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      fonts-dejavu-core \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /out/receiptd /app/receiptd
# cputil-bin is vendored locally via `make vendor-cputil` before `docker build`.
# The directory must stay alongside the binary — cputil loads support files
# from its own dir at runtime.
COPY cputil-bin /app/cputil-bin
# fonts-seed holds bitmap fonts vendored from the maintainer's local install
# via `make vendor-fonts`. They get copied into $HOME/.receiptd/fonts at
# container start, *after* any volume mount, so Fly volumes don't wipe them.
COPY fonts-seed /app/fonts-seed
RUN chmod +x /app/cputil-bin/cputil /app/receiptd

# Entrypoint seeds fonts into the (possibly volume-mounted) data dir on every
# start — cp -n preserves any user-added font files on the volume.
COPY <<'EOF' /app/entrypoint.sh
#!/bin/sh
set -e
mkdir -p "$HOME/.receiptd/fonts"
cp -n /app/fonts-seed/* "$HOME/.receiptd/fonts/" 2>/dev/null || true
exec "$@"
EOF
RUN chmod +x /app/entrypoint.sh

EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["/app/receiptd", "server", "--require-auth"]
