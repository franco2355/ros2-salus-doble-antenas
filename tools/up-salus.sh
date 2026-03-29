#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

docker compose \
  -p ros2_salus \
  -f "${WORKSPACE_DIR}/docker-compose.yml" \
  -f "${WORKSPACE_DIR}/docker-compose.salus.yml" \
  up -d --build "$@"
