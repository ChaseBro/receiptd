.PHONY: build install run clean test help

BINARY_NAME=receiptd
INSTALL_PATH=/usr/local/bin

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
