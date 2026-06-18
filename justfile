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

# generate man pages from docs/ and package them (requires pandoc on PATH)
man:
  @echo "[INFO] Generating man pages from docs/…"
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
