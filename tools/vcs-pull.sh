#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v git >/dev/null 2>&1; then
  echo "Error: 'git' no está instalado." >&2
  exit 1
fi

if [[ ! -d "${WORKSPACE_DIR}/.git" ]]; then
  echo "Error: ${WORKSPACE_DIR} no es un repositorio git." >&2
  exit 1
fi

echo "Actualizando monorepo raíz..."
git -C "${WORKSPACE_DIR}" pull --ff-only "$@"
echo "Workspace actualizado."
