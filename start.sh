#!/bin/bash
# Recall — Flashcard App Launcher
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "  ${BLUE}✦  Recall — Flashcard Study App${NC}"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "  ${RED}✗ Node.js not found.${NC}"
  echo ""
  echo "  Please install Node.js from https://nodejs.org"
  echo "  Or with Homebrew: brew install node"
  echo ""
  read -p "  Press Enter to exit..."
  exit 1
fi

NODE_VER=$(node -v)
echo -e "  ${GREEN}✓${NC} Node.js ${NODE_VER}"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo -e "  ${YELLOW}→${NC} Installing dependencies..."
  npm install --silent
  echo -e "  ${GREEN}✓${NC} Dependencies installed"
fi

PORT=3747

# Kill any existing process on this port
lsof -ti:$PORT | xargs kill -9 2>/dev/null || true

echo -e "  ${GREEN}✓${NC} Starting server on port $PORT"
echo ""
echo -e "  ──────────────────────────────────"
echo -e "  Open: ${BLUE}http://localhost:$PORT${NC}"
echo -e "  ──────────────────────────────────"
echo ""
echo -e "  Press ${YELLOW}Ctrl+C${NC} to stop"
echo ""

# Open browser after short delay
(sleep 1.2 && open "http://localhost:$PORT") &

# Start server
node server.js
