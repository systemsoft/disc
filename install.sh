#!/bin/sh
# Disc installer. Downloads the prebuilt `disc` binary from GitHub releases
# and installs it to ~/.disc/bin. Adapted from Deno’s install script.
# TODO(everyone): Keep this script simple and easily auditable.
#
# Usage:
#   curl -fsSL https://disc.sh/install | sh
#   curl -fsSL https://disc.sh/install | sh -s -- v2026.06.13   # pin a version
#
# Options (pass after `-s --` when piping into sh):
#   -y, --yes          Accept defaults, skip prompts
#   --no-modify-path   Don’t add Disc to the PATH environment variable
#   -h, --help         Print help

set -e

repo="systemsoft/disc"

if ! command -v curl >/dev/null; then
    echo "Error: curl is required to install Disc." 1>&2
    exit 1
fi

# Map the host platform to the published release asset name. Disc uses
# friendly platform slugs (disc-<os>-<arch>) rather than target triples,
# and ships a raw self-contained binary (no archive to unzip).
exe_suffix=""
if [ "$OS" = "Windows_NT" ]; then
    asset="disc-windows-x64.exe"
    exe_suffix=".exe"
else
    case $(uname -sm) in
    "Darwin arm64") asset="disc-darwin-arm64" ;;
    "Darwin x86_64")
        echo "Error: no prebuilt Disc binary for Intel macOS (darwin-x64)." 1>&2
        echo "The Apple Silicon binary runs under Rosetta 2, or build from source:" 1>&2
        echo "  https://github.com/${repo}" 1>&2
        exit 1
        ;;
    "Linux aarch64") asset="disc-linux-arm64" ;;
    "Linux x86_64") asset="disc-linux-x64" ;;
    *)
        echo "Error: unsupported platform $(uname -sm)." 1>&2
        echo "Supported: macOS arm64, Linux x86_64, Linux aarch64, Windows x64." 1>&2
        exit 1
        ;;
    esac
fi

print_help_and_exit() {
    echo "Setup script for installing disc

Options:
  -y, --yes
    Skip interactive prompts and accept defaults
  --no-modify-path
    Don’t add disc to the PATH environment variable
  -h, --help
    Print help

Pass a version as a positional argument to pin it (e.g. v2026.06.13);
the latest release is used otherwise.
"
    echo "Note: Disc was not installed"
    exit 0
}

# Initialize variables
modify_path=true
disc_version=""

# Simple arg parsing - look for the help flag, honor --no-modify-path,
# and take the first non-flag positional arg as the version to install.
for arg in "$@"; do
    case "$arg" in
    "-h" | "--help") print_help_and_exit ;;
    "-y" | "--yes") ;;
    "--no-modify-path") modify_path=false ;;
    "-"*) ;;
    *)
        if [ -z "$disc_version" ]; then
            disc_version="$arg"
        fi
        ;;
    esac
done

# Resolve the download URL. With no version, GitHub’s `latest/download`
# redirect always points at the newest release’s asset, so no separate
# version-resolution endpoint is needed.
if [ -z "$disc_version" ]; then
    asset_url="https://github.com/${repo}/releases/latest/download/${asset}"
else
    # Accept both "2026.06.13" and "v2026.06.13".
    ver="${disc_version#v}"
    asset_url="https://github.com/${repo}/releases/download/v${ver}/${asset}"
fi

disc_install="${DISC_INSTALL:-$HOME/.disc}"
bin_dir="$disc_install/bin"
exe="$bin_dir/disc${exe_suffix}"

if [ ! -d "$bin_dir" ]; then
    mkdir -p "$bin_dir"
fi

curl --fail --location --progress-bar --output "$exe" "$asset_url"

# Best-effort SHA-256 verification against the published `<asset>.sha256`.
# A missing checksum file or sha tool downgrades to a warning rather than
# blocking the install, but a real mismatch is always fatal.
sum_file="$(mktemp)"
if curl --fail --location --silent --output "$sum_file" "${asset_url}.sha256"; then
    expected="$(awk '{print $1}' "$sum_file")"
    actual=""
    if command -v sha256sum >/dev/null; then
        actual="$(sha256sum "$exe" | awk '{print $1}')"
    elif command -v shasum >/dev/null; then
        actual="$(shasum -a 256 "$exe" | awk '{print $1}')"
    fi

    if [ -n "$actual" ] && [ -n "$expected" ]; then
        if [ "$expected" != "$actual" ]; then
            echo "Error: checksum mismatch for ${asset}" 1>&2
            echo "  expected: $expected" 1>&2
            echo "  actual:   $actual" 1>&2
            rm -f "$exe" "$sum_file"
            exit 1
        fi
        echo "Checksum verified (${asset})"
    else
        echo "Note: no sha256 tool found; skipping checksum verification." 1>&2
    fi
else
    echo "Note: checksum file unavailable; skipping verification." 1>&2
fi
rm -f "$sum_file"

chmod +x "$exe"

echo "Disc was installed successfully to $exe"

# Add the bin dir to PATH for future shells, unless it is already there or
# the caller opted out. Idempotent: skips if the rc file already mentions it.
if [ "$modify_path" = "true" ]; then
    case ":$PATH:" in
    *":$bin_dir:"*) ;; # already on PATH for this shell
    *)
        case "${SHELL##*/}" in
        zsh) rc="$HOME/.zshrc"; line="export PATH=\"$bin_dir:\$PATH\"" ;;
        bash) rc="$HOME/.bashrc"; line="export PATH=\"$bin_dir:\$PATH\"" ;;
        fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path \"$bin_dir\"" ;;
        *) rc="$HOME/.profile"; line="export PATH=\"$bin_dir:\$PATH\"" ;;
        esac

        if [ -f "$rc" ] && grep -qF "$bin_dir" "$rc"; then
            : # already configured in the rc file
        else
            mkdir -p "$(dirname "$rc")"
            printf '\n# Disc\n%s\n' "$line" >>"$rc"
            echo "Added Disc to the PATH in $rc"
        fi

        echo "Restart your shell or run: export PATH=\"$bin_dir:\$PATH\""
        ;;
    esac
fi

if command -v disc >/dev/null; then
    echo "Run \"disc --help\" to get started"
else
    echo "Run \"$exe --help\" to get started"
fi
echo
echo "Docs: https://github.com/${repo}"
