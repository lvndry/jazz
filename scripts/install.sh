#!/bin/bash
set -e

# Jazz CLI Installation Script
# Usage: curl -fsSL https://raw.githubusercontent.com/lvndry/jazz/main/scripts/install.sh | bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
GITHUB_REPO="lvndry/jazz"
BINARY_NAME="jazz"
VERSION="${JAZZ_VERSION:-latest}"
INSTALL_DIR="${JAZZ_INSTALL_DIR:-/usr/local/bin}"

# Helper functions
print_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

print_success() {
  echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
  echo -e "${RED}✗${NC} $1"
}

# Detect platform and architecture
detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin)
      PLATFORM="darwin"
      ;;
    Linux)
      PLATFORM="linux"
      ;;
    *)
      print_error "Unsupported operating system: $OS"
      print_info "Supported platforms: macOS (Darwin), Linux"
      exit 1
      ;;
  esac

  case "$ARCH" in
    x86_64)
      ARCH="x64"
      ;;
    arm64|aarch64)
      ARCH="arm64"
      ;;
    *)
      print_error "Unsupported architecture: $ARCH"
      print_info "Supported architectures: x86_64, arm64"
      exit 1
      ;;
  esac

  PLATFORM_BINARY="${BINARY_NAME}-${PLATFORM}-${ARCH}"
}

# Get download URL
get_download_url() {
  if [ "$VERSION" = "latest" ]; then
    DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/${PLATFORM_BINARY}"
    CHECKSUM_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/checksums.txt"
  else
    DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}/${PLATFORM_BINARY}"
    CHECKSUM_URL="https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}/checksums.txt"
  fi
}

# Fallback to npm installation
fallback_to_npm() {
  print_warning "Binary installation failed. Falling back to npm..."

  if command -v npm >/dev/null 2>&1; then
    npm install -g jazz-ai
    print_success "Jazz CLI installed via npm"
    exit 0
  elif command -v bun >/dev/null 2>&1; then
    bun add -g jazz-ai
    print_success "Jazz CLI installed via bun"
    exit 0
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm add -g jazz-ai
    print_success "Jazz CLI installed via pnpm"
    exit 0
  else
    print_error "No package manager found (npm, bun, or pnpm required)"
    print_info "Please install Node.js or Bun first: https://nodejs.org or https://bun.sh"
    exit 1
  fi
}

# Download binary
download_binary() {
  print_info "Downloading Jazz CLI ${VERSION} for ${PLATFORM}-${ARCH}..."

  TMP_DIR=$(mktemp -d)
  TMP_FILE="${TMP_DIR}/${PLATFORM_BINARY}"

  if ! curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"; then
    print_error "Failed to download binary from $DOWNLOAD_URL"
    fallback_to_npm
  fi

  print_success "Downloaded binary"
}

# Verify checksum (optional but recommended)
verify_checksum() {
  if command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1; then
    print_info "Verifying checksum..."

    CHECKSUMS_FILE="${TMP_DIR}/checksums.txt"
    if curl -fsSL "$CHECKSUM_URL" -o "$CHECKSUMS_FILE" 2>/dev/null; then
      if command -v shasum >/dev/null 2>&1; then
        EXPECTED_CHECKSUM=$(grep "$PLATFORM_BINARY" "$CHECKSUMS_FILE" | awk '{print $1}')
        ACTUAL_CHECKSUM=$(shasum -a 256 "$TMP_FILE" | awk '{print $1}')
      else
        EXPECTED_CHECKSUM=$(grep "$PLATFORM_BINARY" "$CHECKSUMS_FILE" | awk '{print $1}')
        ACTUAL_CHECKSUM=$(sha256sum "$TMP_FILE" | awk '{print $1}')
      fi

      if [ "$EXPECTED_CHECKSUM" = "$ACTUAL_CHECKSUM" ]; then
        print_success "Checksum verified"
      else
        print_warning "Checksum mismatch (expected: $EXPECTED_CHECKSUM, got: $ACTUAL_CHECKSUM)"
        print_warning "Continuing anyway..."
      fi
    else
      print_warning "Could not download checksums file, skipping verification"
    fi
  fi
}

# Install binary
install_binary() {
  print_info "Installing to ${INSTALL_DIR}/${BINARY_NAME}..."

  chmod +x "$TMP_FILE"

  # Try to install without sudo first
  if mv "$TMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null; then
    print_success "Installed successfully"
  else
    # Need sudo
    print_warning "Permission denied. Attempting installation with sudo..."
    if sudo mv "$TMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}"; then
      print_success "Installed successfully (with sudo)"
    else
      print_error "Failed to install binary"
      print_info "Try setting JAZZ_INSTALL_DIR to a directory you have write access to:"
      print_info "  curl -fsSL https://raw.githubusercontent.com/lvndry/jazz/main/install.sh | JAZZ_INSTALL_DIR=~/.local/bin bash"
      exit 1
    fi
  fi

  # Cleanup
  rm -rf "$TMP_DIR"
}

# Check if already installed
check_existing() {
  if command -v jazz >/dev/null 2>&1; then
    CURRENT_VERSION=$(jazz --version 2>/dev/null || echo "unknown")
    print_warning "Jazz CLI is already installed (version: $CURRENT_VERSION)"
    read -p "Do you want to reinstall/update? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      print_info "Installation cancelled"
      exit 0
    fi
  fi
}

# Main installation flow
main() {
  echo ""
  echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║${NC}     Jazz CLI Installation Script     ${BLUE}║${NC}"
  echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
  echo ""

  check_existing
  detect_platform
  get_download_url
  download_binary
  verify_checksum
  install_binary

  echo ""
  print_success "Jazz CLI installed successfully! 🎷"
  echo ""
  print_info "Get started by running: ${GREEN}jazz${NC}"
  print_info "Create your first agent: ${GREEN}jazz agent create${NC}"
  print_info "View all commands: ${GREEN}jazz --help${NC}"
  echo ""
  print_info "Documentation: https://github.com/lvndry/jazz"
  echo ""
}

main
