default:
  @just --list

build: build-linux build-mac build-windows

build-linux:
  @echo "[INFO] Building Linux executables…"
  mkdir -p build/linux
  mkdir -p build/linux-64

  @echo "[INFO] Linux ARM executable"
  deno task build:linux-arm64
  mv disc-linux-arm64 build/linux/disc

  @echo "[INFO] Linux x64 executable"
  deno task build:linux-x64
  mv disc-linux-x64 build/linux-64/disc

build-mac:
  @echo "[INFO] Building macOS executable…"
  mkdir -p build/mac
  deno task build:darwin-arm64
  mv disc-darwin-arm64 build/mac/disc

build-windows:
  @echo "[INFO] Building Windows executable…"
  mkdir -p build/windows-64
  deno task build:windows-x64
  mv disc-windows-x64.exe build/windows-64/disc.exe

clean:
  rm -rf build

# run project for local development
dev:
  deno task dev

format:
  deno task format

# initialize/update the documentation submodule (github.com/systemsoft/disc.md).
# `docs-sync` fast-forwards the pin to the site's latest primary; committing the
# resulting submodule bump is what makes a release ship those docs.
docs-init:
  git submodule update --init vendor/disc.md

docs-sync:
  git submodule update --init --remote vendor/disc.md
  @echo "[INFO] Pin moved — commit vendor/disc.md to record it."

# generate man pages from the disc.md submodule and package them
# (requires pandoc on PATH; run `just docs-sync` if the submodule is empty)
man:
  @echo "[INFO] Generating man pages from vendor/disc.md/documents…"
  @deno task man
  @echo "[INFO] Packaging man pages → build/disc-man.tar.gz"
  tar -czf build/disc-man.tar.gz -C build/man .

release: version clean build man
  @echo "[INFO] Release versioned, built, and man pages generated"

# generate version.txt and update everywhere
version:
  @echo "[INFO] Updating version.txt with ChronVer"
  @deno task version:bump
  @echo "[INFO] Version updated: $(cat version.txt)"
