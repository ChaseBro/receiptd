.PHONY: build install run clean test help vendor-cputil docker-build

BINARY_NAME=receiptd
INSTALL_PATH=/usr/local/bin

# Path to the Star cputil Linux tarball. Override on the command line or in
# the environment if yours lives elsewhere:
#   make vendor-cputil CPUTIL_TARBALL=/path/to/cputil-linux-x64_vXXX.tar.gz
CPUTIL_TARBALL ?= ../photo-receipts/bin/cputil-linux-x64_v201.tar.gz
FONTS_SRC ?= $(HOME)/.receiptd/fonts
DOCKER_IMAGE ?= receiptd:dev

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

build: ## Build the receiptd binary
	@echo "🔨 Building receiptd..."
	go build -o $(BINARY_NAME) ./cmd/receiptd
	@echo "✅ Build complete: ./$(BINARY_NAME)"

install: build ## Install receiptd to /usr/local/bin
	@echo "📦 Installing receiptd..."
	sudo cp $(BINARY_NAME) $(INSTALL_PATH)/
	@echo "✅ Installed to $(INSTALL_PATH)/$(BINARY_NAME)"

run: build ## Build and run receiptd
	./$(BINARY_NAME)

clean: ## Remove build artifacts
	@echo "🧹 Cleaning..."
	rm -f $(BINARY_NAME)
	go clean
	@echo "✅ Clean complete"

test: ## Run tests (when implemented)
	go test -v ./...

vendor-cputil: ## Extract the Linux cputil SDK into ./cputil-bin (needed for docker build)
	@test -f "$(CPUTIL_TARBALL)" || { echo "❌ $(CPUTIL_TARBALL) not found — set CPUTIL_TARBALL=/path/to/cputil-linux-x64_vXXX.tar.gz"; exit 1; }
	@echo "📦 Vendoring cputil from $(CPUTIL_TARBALL)..."
	@rm -rf cputil-bin
	@mkdir -p cputil-bin
	@tar -xzf "$(CPUTIL_TARBALL)" --strip-components=2 -C cputil-bin
	@chmod +x cputil-bin/cputil
	@echo "✅ Vendored to ./cputil-bin"

vendor-fonts: ## Copy locally-installed bitmap fonts into ./fonts-seed (baked into the image)
	@test -d "$(FONTS_SRC)" || { echo "❌ $(FONTS_SRC) not found — install fonts locally first (receiptd fonts install ...)"; exit 1; }
	@echo "📦 Vendoring fonts from $(FONTS_SRC)..."
	@rm -rf fonts-seed
	@mkdir -p fonts-seed
	@cp -p "$(FONTS_SRC)"/*.ttf "$(FONTS_SRC)"/*.woff2 fonts-seed/ 2>/dev/null || true
	@count=$$(ls fonts-seed/ 2>/dev/null | wc -l | tr -d ' '); \
	 if [ "$$count" = "0" ]; then echo "❌ no fonts found in $(FONTS_SRC)"; exit 1; fi; \
	 echo "✅ Vendored $$count font(s) to ./fonts-seed"

docker-build: vendor-cputil vendor-fonts ## Build the Linux/amd64 container image
	docker build --platform linux/amd64 -t $(DOCKER_IMAGE) .
	@echo "✅ Built $(DOCKER_IMAGE)"

demo: build ## Run a demo of all commands
	@echo "🎬 Running receiptd demo..."
	@echo "\n=== Server Commands ==="
	./$(BINARY_NAME) server &
	sleep 1
	./$(BINARY_NAME) server stop
	@echo "\n=== Status ==="
	./$(BINARY_NAME) status
	./$(BINARY_NAME) --json status
	@echo "\n=== Printer Discovery ==="
	./$(BINARY_NAME) printer discover
	@echo "\n=== Printer List ==="
	./$(BINARY_NAME) printer list
	./$(BINARY_NAME) --json printer list
	@echo "\n=== Print Jobs ==="
	./$(BINARY_NAME) jobs
	./$(BINARY_NAME) --json jobs
	@echo "\n=== Config ==="
	./$(BINARY_NAME) config show
	@echo "\n=== Print Command ==="
	./$(BINARY_NAME) print "Hello from receiptd!"
	./$(BINARY_NAME) --json print "JSON output test"
	@echo "\n✅ Demo complete"

.DEFAULT_GOAL := help
