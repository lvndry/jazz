# Jazz CLI Makefile
# Provides convenient commands for development, building, and testing

.PHONY: help install build dev test test-watch lint lint-fix format clean start cli install-global uninstall-global push-tag patch minor major

# Default target
help: ## Show this help message
	@echo "Jazz CLI - Available commands:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# Installation and setup
install: ## Install dependencies
	@echo "Installing dependencies..."
	bun install

# Development
dev: ## Start development server with hot reload
	@echo "Starting development server..."
	bun --watch src/main.ts

start: build ## Start the built application
	@echo "Starting Jazz CLI..."
	bun dist/main.js

cli: ## Run CLI directly from source
	@echo "Running CLI from source..."
	bun src/main.ts

# Building
build: clean ## Build the project
	@echo "Building Jazz CLI..."
	bun run build

clean: ## Clean build artifacts
	@echo "Cleaning build artifacts..."
	bun run clean

# Testing
test: ## Run tests
	@echo "Running tests..."
	bun test

test-watch: ## Run tests in watch mode
	@echo "Running tests in watch mode..."
	bun run test:watch

# Code quality
lint: ## Run linting
	@echo "Running linter..."
	bun run lint

lint-fix: ## Fix linting issues
	@echo "Fixing linting issues..."
	bun run lint:fix

format: ## Format code
	@echo "Formatting code..."
	bun run format

# Development workflow
check: lint test ## Run linting and tests
	@echo "All checks passed!"

pre-commit: format lint-fix test ## Run pre-commit checks
	@echo "Pre-commit checks completed!"

# Release
release-check: check ## Check if ready for release
	@echo "Checking release readiness..."
	@echo "Version: $$(grep '"version"' package.json | cut -d'"' -f4)"
	@echo "Build status: $$(if [ -d dist ]; then echo "Built"; else echo "Not built"; fi)"
	@echo "Tests: $$(if bun test >/dev/null 2>&1; then echo "Passing"; else echo "Failing"; fi)"

release-build: clean build test ## Build release version
	@echo "Building release version..."
	@echo "Release build completed!"

# Docker
docker-build: ## Build Docker image
	@echo "Building Docker image..."
	@if [ -f Dockerfile ]; then \
		docker build -t jazz:latest .; \
	else \
		echo "Dockerfile not found"; \
	fi

docker-run: ## Run Docker container
	@echo "Running Docker container..."
	@if [ -f Dockerfile ]; then \
		docker run -it --rm jazz:latest; \
	else \
		echo "Dockerfile not found"; \
	fi

# Environment setup
setup: install ## Complete development setup
	@echo "Setting up development environment..."
	@echo "✅ Dependencies installed"
	@echo "✅ Development environment ready"
	@echo ""
	@echo "Next steps:"
	@echo "  make dev     - Start development server"
	@echo "  make test    - Run tests"
	@echo "  make build   - Build the project"

# CI/CD helpers
ci-install: ## Install dependencies for CI
	@echo "Installing dependencies for CI..."
	bun install --frozen-lockfile

ci-test: ## Run tests for CI
	@echo "Running CI tests..."
	bun test --coverage

ci-build: ## Build for CI
	@echo "Building for CI..."
	bun run build

# Utility commands
version: ## Show version information
	@echo "Jazz CLI Version Information:"
	@echo "Package version: $$(grep '"version"' package.json | cut -d'"' -f4)"
	@echo "Node version: $$(node --version)"
	@echo "Bun version: $$(bun --version)"
	@echo "TypeScript version: $$(bunx tsc --version)"

info: ## Show project information
	@echo "Jazz CLI Project Information:"
	@echo "Name: $$(grep '"name"' package.json | cut -d'"' -f4)"
	@echo "Description: $$(grep '"description"' package.json | cut -d'"' -f4)"
	@echo "Author: $$(grep '"author"' package.json | cut -d'"' -f4)"
	@echo "License: $$(grep '"license"' package.json | cut -d'"' -f4)"
	@echo "Repository: $$(grep '"repository"' package.json | cut -d'"' -f4 || echo 'Not specified')"

# Cleanup
clean-all: clean ## Clean everything including node_modules
	@echo "Cleaning everything..."
	rm -rf node_modules
	rm -rf dist
	rm -rf .bun
	@echo "Complete cleanup finished!"

# Development helpers
watch: ## Watch for changes and rebuild
	@echo "Watching for changes..."
	@if command -v nodemon >/dev/null 2>&1; then \
		nodemon --watch src --ext ts --exec "bun run build"; \
	else \
		echo "Nodemon not installed. Install with: npm install -g nodemon"; \
		echo "Or use: make dev"; \
	fi

# Quick development cycle
quick: format lint-fix build test ## Quick development cycle
	@echo "Quick development cycle completed!"

# Show file structure
tree: ## Show project structure
	@echo "Project structure:"
	@tree -I 'node_modules|dist|.git' -a

# Security
audit: ## Run security audit
	@echo "Running security audit..."
	bun audit

# Update dependencies
update: ## Update dependencies
	@echo "Updating dependencies..."
	bun update

# Version bumping
push-tag: ## Push tags to remote (git push --follow-tags)
	@echo "Pushing tags to remote..."
	@git push --follow-tags

patch: ## Bump patch version (e.g., 0.4.5 -> 0.4.6)
	@echo "Bumping patch version..."
	@npm version patch
	@$(MAKE) push-tag

minor: ## Bump minor version (e.g., 0.4.5 -> 0.5.0)
	@echo "Bumping minor version..."
	@npm version minor
	@$(MAKE) push-tag

major: ## Bump major version (e.g., 0.4.5 -> 1.0.0)
	@echo "Bumping major version..."
	@npm version major
	@$(MAKE) push-tag
