default:
  @just --list

build: build-linux build-mac

build-linux:
  @echo "[INFO] Building Linux executables…"
  deno run --allow-read --allow-write cli/prep.ts
  mkdir -p build/linux
  mkdir -p build/linux-64

  @echo "[INFO] Linux ARM executable"
  deno run --allow-all --no-check cli/main.ts build --platform linux-arm64
  mv disc-linux-arm64 build/linux/disc

  @echo "[INFO] Linux x64 executable"
  deno run --allow-all --no-check cli/main.ts build --platform linux-x64
  mv disc-linux-x64 build/linux-64/disc

build-mac:
  @echo "[INFO] Building macOS executable…"
  deno run --allow-read --allow-write cli/prep.ts
  mkdir -p build/mac
  deno run --allow-all --no-check cli/main.ts build --platform darwin-arm64
  mv disc-darwin-arm64 build/mac/disc

clean:
  rm -rf build

# run project for local development
dev:
  deno run --allow-env --allow-net --allow-read --allow-write --watch cli/main.ts development

format:
  dprint fmt

release: version clean build
  @echo "[INFO] Release versioned and built"

# run project for production
# start:
#   deno run --allow-read --allow-env --allow-net entry.ts

# generate version.txt and update everywhere
version:
  @echo "[INFO] Updating version.txt with ChronVer"
  @deno run --allow-read=deno.json,lib/version.ts --allow-write=version.txt,deno.json,lib/version.ts scripts/version.ts
  @echo "[INFO] Version updated: $(cat version.txt)"
