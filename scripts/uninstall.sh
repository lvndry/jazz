#!/bin/bash
set -e

# Jazz CLI Uninstall Script
# Usage: curl -fsSL https://raw.githubusercontent.com/lvndry/jazz/main/scripts/uninstall.sh | bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BINARY_NAME="jazz"
INSTALL_LOCATIONS=(
  "/usr/local/bin/jazz"
  "$HOME/.local/bin/jazz"
  "/opt/homebrew/bin/jazz"
  "/usr/bin/jazz"
)

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

# Find Jazz installation
find_jazz() {
  JAZZ_PATH=""

  # First check if jazz is in PATH
  if command -v jazz >/dev/null 2>&1; then
    JAZZ_PATH=$(which jazz)
    print_info "Found Jazz at: $JAZZ_PATH"
    return 0
  fi

  # Check common installation locations
  for location in "${INSTALL_LOCATIONS[@]}"; do
    if [ -f "$location" ]; then
      JAZZ_PATH="$location"
      print_info "Found Jazz at: $JAZZ_PATH"
      return 0
    fi
  done

  return 1
}

# Remove Jazz binary
remove_binary() {
  if [ -z "$JAZZ_PATH" ]; then
    print_error "Jazz installation not found"
    return 1
  fi

  print_info "Removing Jazz from $JAZZ_PATH..."

  # Try to remove without sudo first
  if rm "$JAZZ_PATH" 2>/dev/null; then
    print_success "Removed Jazz binary"
  else
    # Need sudo
    print_warning "Permission denied. Attempting removal with sudo..."
    if sudo rm "$JAZZ_PATH"; then
      print_success "Removed Jazz binary (with sudo)"
    else
      print_error "Failed to remove Jazz binary"
      return 1
    fi
  fi
}

# Clean up Jazz data (optional)
cleanup_data() {
  JAZZ_DIR="$HOME/.jazz"

  if [ -d "$JAZZ_DIR" ]; then
    echo ""
    read -p "Do you want to remove Jazz data directory (~/.jazz)? This will delete all agents, workflows, and configuration. [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      print_info "Removing Jazz data directory..."
      if rm -rf "$JAZZ_DIR"; then
        print_success "Removed Jazz data directory"
      else
        print_warning "Failed to remove Jazz data directory"
      fi
    else
      print_info "Keeping Jazz data directory"
    fi
  fi
}

# Check for npm/bun installation
check_package_managers() {
  echo ""
  print_info "Checking for package manager installations..."

  # Check npm
  if command -v npm >/dev/null 2>&1; then
    if npm list -g jazz-ai >/dev/null 2>&1; then
      print_warning "Jazz is also installed via npm"
      read -p "Do you want to uninstall from npm? [y/N] " -n 1 -r
      echo
      if [[ $REPLY =~ ^[Yy]$ ]]; then
        npm uninstall -g jazz-ai
        print_success "Uninstalled from npm"
      fi
    fi
  fi

  # Check bun
  if command -v bun >/dev/null 2>&1; then
    if bun pm ls -g 2>/dev/null | grep -q "jazz-ai"; then
      print_warning "Jazz is also installed via bun"
      read -p "Do you want to uninstall from bun? [y/N] " -n 1 -r
      echo
      if [[ $REPLY =~ ^[Yy]$ ]]; then
        bun remove -g jazz-ai
        print_success "Uninstalled from bun"
      fi
    fi
  fi

  # Check Homebrew
  if command -v brew >/dev/null 2>&1; then
    if brew list jazz >/dev/null 2>&1; then
      print_warning "Jazz is installed via Homebrew"
      read -p "Do you want to uninstall from Homebrew? [y/N] " -n 1 -r
      echo
      if [[ $REPLY =~ ^[Yy]$ ]]; then
        brew uninstall jazz
        print_success "Uninstalled from Homebrew"

        read -p "Do you want to remove the Homebrew tap? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
          brew untap lvndry/jazz 2>/dev/null || true
          print_success "Removed Homebrew tap"
        fi
      fi
    fi
  fi
}

# Main uninstall flow
main() {
  echo ""
  echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║${NC}   Jazz CLI Uninstallation Script    ${BLUE}║${NC}"
  echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
  echo ""

  # Confirm uninstallation
  read -p "Are you sure you want to uninstall Jazz CLI? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_info "Uninstallation cancelled"
    exit 0
  fi

  echo ""

  # Find and remove binary
  if find_jazz; then
    remove_binary
  else
    print_warning "Jazz binary not found in common locations"
  fi

  # Check package managers
  check_package_managers

  # Optional data cleanup
  cleanup_data

  echo ""
  print_success "Jazz CLI uninstalled successfully! 👋"
  echo ""
  print_info "To reinstall Jazz, visit: https://github.com/lvndry/jazz"
  echo ""
}

main
