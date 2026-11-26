#!/usr/bin/env bash
# Vigil macOS and Linux launcher (#264, decision 0008).
# Checks Docker, starts the compose services, and opens the browser.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Check Docker CLI
if ! command -v docker >/dev/null 2>&1; then
  echo "" >&2
  echo "Docker bulunamadi / Docker is not installed." >&2
  echo "Lutfen Docker Desktop (macOS) veya Docker Engine (Linux) kurun:" >&2
  echo "Please install Docker Desktop (macOS) or Docker Engine (Linux):" >&2
  echo "  https://docs.docker.com/get-docker/" >&2
  echo "" >&2
  exit 1
fi

# Check Docker daemon is running
if ! docker info >/dev/null 2>&1; then
  echo "" >&2
  echo "Docker daemon calismiyor / Docker daemon is not running." >&2
  echo "Lutfen Docker Desktop uygulamasini baslatin veya Docker servisini acin:" >&2
  echo "Please start Docker Desktop (macOS) or start the Docker service (Linux):" >&2
  echo "  sudo systemctl start docker" >&2
  echo "" >&2
  exit 1
fi

# Check Docker Compose plugin
if ! docker compose version >/dev/null 2>&1; then
  echo "" >&2
  echo "'docker compose' eklentisi bulunamadi / 'docker compose' plugin not found." >&2
  echo "Lutfen Docker'i guncelleyin veya Compose eklentisini kurun:" >&2
  echo "Please update Docker or install the Compose plugin:" >&2
  echo "  https://docs.docker.com/compose/install/" >&2
  echo "" >&2
  exit 1
fi

# Start compose services
echo "Vigil baslatiliyor / Starting Vigil..."
docker compose up -d

# Wait for the web app
APP_URL="http://127.0.0.1:3000"
echo "Servislerin hazir olmasi bekleniyor / Waiting for Vigil to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0
READY=false

while [ "$RETRY_COUNT" -lt "$MAX_RETRIES" ]; do
  if command -v curl >/dev/null 2>&1; then
    if curl -s -f "$APP_URL" >/dev/null 2>&1; then
      READY=true
      break
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q -O - "$APP_URL" >/dev/null 2>&1; then
      READY=true
      break
    fi
  else
    sleep 3
    READY=true
    break
  fi
  RETRY_COUNT=$((RETRY_COUNT + 1))
  sleep 1
done

if [ "$READY" = true ]; then
  echo "Vigil hazir / Vigil is ready: $APP_URL"
else
  echo "Servis yanit veriyor, tarayici aciliyor / Opening browser..."
fi

# Open browser on macOS and Linux
open_browser() {
  local url="$1"
  if [ "$(uname)" = "Darwin" ]; then
    open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  elif command -v sensible-browser >/dev/null 2>&1; then
    sensible-browser "$url" >/dev/null 2>&1 || true
  elif command -v gio >/dev/null 2>&1; then
    gio open "$url" >/dev/null 2>&1 || true
  else
    echo "Tarayicinizda acin / Open in browser: $url"
  fi
}

open_browser "$APP_URL"

echo ""
echo "Vigil calisiyor / Vigil is running: $APP_URL"
echo "Durdurmak icin / To stop Vigil: docker compose down"
echo ""
