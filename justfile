default:
  @just --list

build: build-linux build-mac

build-linux:
  @echo "[INFO] Building Linux executables…"
  @echo "[INFO] Linux ARM executable"
  deno compile \
    --allow-env \
    --allow-net \
    --allow-read \
    --allow-run \
    --allow-write \
    --output build/linux-64/disc \
    --target aarch64-unknown-linux-gnu \
    --no-check \
    --include=version.txt \
    cli/main.ts

  @echo "[INFO] Linux x64 executable"
  deno compile \
    --allow-env \
    --allow-net \
    --allow-read \
    --allow-run \
    --allow-write \
    --output build/linux/disc \
    --target x86_64-unknown-linux-gnu \
    --no-check \
    --include=version.txt \
    cli/main.ts

build-mac:
  @echo "[INFO] Building macOS executable…"
  deno compile \
    --allow-env \
    --allow-net \
    --allow-read \
    --allow-run \
    --allow-write \
    --output build/mac/disc \
    --target aarch64-apple-darwin \
    --no-check \
    --include=version.txt \
    cli/main.ts

clean:
  rm -rf build

# run project for local development
dev:
  deno run --allow-env --allow-net --allow-read --allow-write --watch cli/main.ts development

release: version clean build
  @echo "[INFO] Release versioned and built"

# run project for production
# start:
#   deno run --allow-read --allow-env --allow-net entry.ts

# generate version.txt
version:
  @echo "[INFO] Updating version.txt with ChronVer"
  @deno eval "const now = new Date(); const version = \`\${now.getFullYear()}.\${String(now.getMonth() + 1).padStart(2, '0')}.\${String(now.getDate()).padStart(2, '0')}\`; console.log(version); await Deno.writeTextFile('version.txt', version);"
  @echo "[INFO] Version updated: $(cat version.txt)"
