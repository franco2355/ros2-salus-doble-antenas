#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

npm run build
npm run package:vsix

VSIX_PATH="${REPO_ROOT}/cockpit.vsix"
if [[ ! -f "$VSIX_PATH" ]]; then
  echo "No encontré VSIX generado: $VSIX_PATH"
  exit 1
fi

PROFILE_NAME="${VSCODE_PROFILE:-}"
if [[ -z "$PROFILE_NAME" ]]; then
  STORAGE_JSON="${HOME}/.config/Code/User/globalStorage/storage.json"
  if [[ -f "$STORAGE_JSON" ]]; then
    PROFILE_NAME="$(node - "$REPO_ROOT" "$STORAGE_JSON" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const storagePath = process.argv[3];

const toFileUri = (inputPath) => {
  const normalized = inputPath.replace(/\\/g, "/");
  return `file://${normalized.split("/").map((segment, idx) => (idx === 0 ? segment : encodeURIComponent(segment))).join("/")}`;
};

try {
  const content = fs.readFileSync(storagePath, "utf8");
  const json = JSON.parse(content);
  const associations = json?.profileAssociations?.workspaces ?? {};
  const candidates = [
    toFileUri(path),
    toFileUri(`${path}/.vscode/cockpit.code-workspace`),
    toFileUri(`${path}/.vscode/workspace.code-workspace`)
  ];

  let locationId = "";
  for (const candidate of candidates) {
    if (typeof associations[candidate] === "string" && associations[candidate].trim().length > 0) {
      locationId = associations[candidate].trim();
      break;
    }
  }

  if (!locationId) {
    process.stdout.write("");
    process.exit(0);
  }

  const profiles = Array.isArray(json?.userDataProfiles) ? json.userDataProfiles : [];
  const profile = profiles.find((entry) => entry && entry.location === locationId);
  if (profile && typeof profile.name === "string" && profile.name.trim().length > 0) {
    process.stdout.write(profile.name.trim());
    process.exit(0);
  }

  process.stdout.write(locationId);
} catch {
  process.stdout.write("");
}
NODE
)"
  fi
fi

PREFERRED_CLI=""
case "${VSCODE_CODE_CACHE_PATH:-}" in
  *"/VSCodium/"*) PREFERRED_CLI="codium" ;;
  *"/Code - Insiders/"*) PREFERRED_CLI="code-insiders" ;;
  *"/Code/"*) PREFERRED_CLI="code" ;;
esac

CODE_BIN=""
if [[ -n "${VSCODE_CLI:-}" ]] && [[ "$VSCODE_CLI" != "1" ]] && command -v "$VSCODE_CLI" >/dev/null 2>&1; then
  CODE_BIN="$(command -v "$VSCODE_CLI")"
fi

if [[ -z "$CODE_BIN" ]]; then
  for candidate in "$PREFERRED_CLI" code codium code-insiders; do
    [[ -z "$candidate" ]] && continue
    if command -v "$candidate" >/dev/null 2>&1; then
      CODE_BIN="$(command -v "$candidate")"
      break
    fi
  done
fi

if [[ -z "$CODE_BIN" ]]; then
  echo "No encontré CLI VSCode (code/codium/code-insiders)."
  exit 1
fi

echo "CLI seleccionada: $CODE_BIN"
if [[ -n "$PROFILE_NAME" ]]; then
  echo "Perfil seleccionado: $PROFILE_NAME"
  "$CODE_BIN" --profile "$PROFILE_NAME" --install-extension "$VSIX_PATH" --force
else
  echo "Perfil seleccionado: default"
  "$CODE_BIN" --install-extension "$VSIX_PATH" --force
fi

LIST_CMD=("$CODE_BIN" --list-extensions)
if [[ -n "$PROFILE_NAME" ]]; then
  LIST_CMD+=("--profile" "$PROFILE_NAME")
fi

if "${LIST_CMD[@]}" | grep -qx 'cockpit.cockpit-vscode'; then
  echo "Extensión instalada: cockpit.cockpit-vscode"
else
  echo "Instalación terminó, pero no pude confirmar cockpit.cockpit-vscode"
fi
