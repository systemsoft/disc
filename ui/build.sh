#!/bin/bash

# Build script for Disc UI

# Everything below assumes ui/ is the working directory (bun resolves
# package.json from cwd), but the script is documented as
# `bash ui/build.sh` and invoked from the repo root by `just ui-build`.
cd "$(dirname "$0")" || exit 1
REPO_ROOT="$(cd .. && pwd)"

# Refresh the checked-in `server/ui-asset-manifest.ts` from the build that
# just ran. Every asset name is content-hashed, so a rebuild without a regen
# leaves the manifest naming files that no longer exist and the server 404s
# assets sitting right there on disk. `cli/build.test.ts` catches the drift,
# but only on a machine that has built the UI — doing it here means whoever
# produced the new hashes also gets the manifest that names them.
regenerate_manifest() {
  local repo_root="$1"

  if ! command -v deno &> /dev/null; then
    echo "⚠️  deno not found — UI asset manifest NOT refreshed."
    echo "   Run \`deno task ui:manifest\` before committing, or CI will fail."
    return 0
  fi

  echo "🧾 Refreshing UI asset manifest…"
  (cd "$repo_root" && deno task ui:manifest) || return 1
}

echo "🎨 Building Disc Admin UI…"

# Check if npm is installed
if ! command -v bun &> /dev/null; then
  echo "❌ bun is not installed. Please install bun."
  exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies…"
  bun install
fi

# Build the UI
echo "🔨 Building UI…"
bun run build

if [ $? -ne 0 ]; then
  echo "❌ Build failed"
  exit 1
fi

if ! regenerate_manifest "$REPO_ROOT"; then
  echo "❌ UI asset manifest refresh failed"
  exit 1
fi

echo "✅ UI built successfully!"
echo "📁 Build output: $(pwd)/build"
