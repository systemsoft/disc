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
#   --no-man           Don’t install man pages
#   --system-man       Install man pages to /usr/local/share/man (sudo if needed)
#   --man-dir=DIR      Install man pages under DIR (expects man1/ man7/ subdirs)
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
  --no-man
    Don’t install man pages
  --system-man
    Install man pages to /usr/local/share/man (uses sudo if needed)
  --man-dir=DIR
    Install man pages under DIR (expects man1/ and man7/ subdirectories)
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
install_man=true
system_man=false
man_dir=""

# Simple arg parsing - look for the help flag, honor --no-modify-path,
# and take the first non-flag positional arg as the version to install.
for arg in "$@"; do
    case "$arg" in
    "-h" | "--help") print_help_and_exit ;;
    "-y" | "--yes") ;;
    "--no-modify-path") modify_path=false ;;
    "--no-man") install_man=false ;;
    "--system-man") system_man=true ;;
    "--man-dir="*) man_dir="${arg#*=}" ;;
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

# Report the PIDs of processes currently executing "$1", one per line.
#
# Matches on file identity rather than process name. A machine can carry
# several `disc` binaries at once — a Homebrew build, a from-source dev build,
# this release install — and only processes running the binary being replaced
# belong in the warning below; flagging the others would train people to ignore
# it. Process name can't make that distinction: something started as
# `disc serve` through a PATH lookup reports a bare `disc` to `ps -o comm=`,
# with no trace of the directory it was loaded from.
#
# Linux reads /proc directly so the check holds in a minimal container with no
# lsof. Elsewhere lsof is the portable way to ask "who has this file open", and
# its absence degrades to silence — the warning is advisory, so a missing tool
# must not fail an otherwise good install.
running_disc_pids() {
    _target="$1"
    [ -e "$_target" ] || return 0

    if [ -d /proc ]; then
        for _entry in /proc/[0-9]*; do
            if [ "$(readlink "$_entry/exe" 2>/dev/null)" = "$_target" ]; then
                echo "${_entry#/proc/}"
            fi
        done
    elif command -v lsof >/dev/null 2>&1; then
        lsof -t -- "$_target" 2>/dev/null || true
    fi

    # Never propagate a non-zero status: no matches is the common case, and
    # `set -e` would turn it into a failed install.
    return 0
}

# Name the processes still running the superseded binary.
#
# Advisory, not a blocker. The rename below already makes the upgrade safe to
# perform while Disc is running, but a live `disc serve` holds its original
# mapping until it exits, so it keeps serving the old version — which reads as
# "the upgrade didn't take" unless we say so. Silent on the common path.
warn_running_instances() {
    _pids="$1"
    [ -n "$_pids" ] || return 0

    echo 1>&2
    echo "Warning: these processes are still running the previous binary:" 1>&2
    # Deliberately unquoted: "$_pids" is a whitespace-separated PID list.
    for _pid in $_pids; do
        _cmd="$(ps -p "$_pid" -o args= 2>/dev/null || true)"
        if [ -n "$_cmd" ]; then
            echo "  pid $_pid  $_cmd" 1>&2
        else
            echo "  pid $_pid" 1>&2
        fi
    done
    echo "Restart them to pick up the new version." 1>&2

    return 0
}

# Capture before the rename — afterwards "$exe" names a different file and
# these processes can no longer be attributed to it.
running_before="$(running_disc_pids "$exe")"

# Download beside the target, then rename into place. Writing straight to
# "$exe" truncates the existing install in place, reusing its inode. When any
# process launched from the old binary is still alive (`disc serve` is the
# common case — upgrading without stopping the server first), the kernel still
# has that inode mapped as executable text. Rewriting those pages underneath it
# invalidates the code-signature pages for the vnode, and macOS then SIGKILLs
# every subsequent exec with "Taskgated Invalid Signature" — even though the
# downloaded bytes are correct and `codesign --verify --strict` passes on the
# file. Reproduced on macOS 27 (arm64); the symptom is a bare `killed  disc`.
#
# rename(2) publishes a new inode instead: running processes keep their old
# mapping until they exit, and new execs get clean bytes. It also makes the
# upgrade atomic — an interrupted download leaves the previous binary intact
# rather than a truncated one.
#
# The temp file must live in "$bin_dir" — a cross-filesystem `mv` degrades to
# copy-onto-destination, which reintroduces the in-place truncation it exists
# to avoid.
exe_tmp="$exe.tmp.$$"
trap 'rm -f "$exe_tmp"' EXIT
curl --fail --location --progress-bar --output "$exe_tmp" "$asset_url"

# Best-effort SHA-256 verification against the published `<asset>.sha256`.
# A missing checksum file or sha tool downgrades to a warning rather than
# blocking the install, but a real mismatch is always fatal.
sum_file="$(mktemp)"
if curl --fail --location --silent --output "$sum_file" "${asset_url}.sha256"; then
    expected="$(awk '{print $1}' "$sum_file")"
    actual=""
    if command -v sha256sum >/dev/null; then
        actual="$(sha256sum "$exe_tmp" | awk '{print $1}')"
    elif command -v shasum >/dev/null; then
        actual="$(shasum -a 256 "$exe_tmp" | awk '{print $1}')"
    fi

    if [ -n "$actual" ] && [ -n "$expected" ]; then
        if [ "$expected" != "$actual" ]; then
            echo "Error: checksum mismatch for ${asset}" 1>&2
            echo "  expected: $expected" 1>&2
            echo "  actual:   $actual" 1>&2
            rm -f "$exe_tmp" "$sum_file"
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

chmod +x "$exe_tmp"
mv -f "$exe_tmp" "$exe"
trap - EXIT

echo "Disc was installed successfully to $exe"

warn_running_instances "$running_before"

# Append a MANPATH entry for a user-local man root (idempotent), mirroring the
# PATH handling below. Only needed when man pages land outside the default
# manpath (e.g. ~/.disc/share/man).
add_manpath_to_rc() {
    _man_root="$1"
    case "${SHELL##*/}" in
    zsh) _rc="$HOME/.zshrc"; _line="export MANPATH=\"$_man_root:\$MANPATH\"" ;;
    bash) _rc="$HOME/.bashrc"; _line="export MANPATH=\"$_man_root:\$MANPATH\"" ;;
    fish) _rc="$HOME/.config/fish/config.fish"; _line="set -gx MANPATH \"$_man_root\" \$MANPATH" ;;
    *) _rc="$HOME/.profile"; _line="export MANPATH=\"$_man_root:\$MANPATH\"" ;;
    esac

    if [ -f "$_rc" ] && grep -qF "$_man_root" "$_rc"; then
        : # already configured in the rc file
    else
        mkdir -p "$(dirname "$_rc")"
        printf '\n# Disc man pages\n%s\n' "$_line" >>"$_rc"
        echo "Added Disc man pages to MANPATH in $_rc"
    fi
}

# Best-effort man-page install. The archive (`disc-man.tar.gz`) sits next to
# the binary on the release. A missing archive, a read-only target, or no sudo
# all downgrade to a warning — the binary install above already succeeded, so
# man pages are never allowed to fail the install.
install_man_pages() {
    [ "$install_man" = "true" ] || return 0

    man_asset_url="${asset_url%/*}/disc-man.tar.gz"
    man_tarball="$(mktemp)"
    if ! curl --fail --location --silent --output "$man_tarball" "$man_asset_url"; then
        echo "Note: man-page archive unavailable; skipping man install." 1>&2
        rm -f "$man_tarball"
        return 0
    fi

    man_stage="$(mktemp -d)"
    if ! tar -xzf "$man_tarball" -C "$man_stage" 2>/dev/null; then
        echo "Note: could not extract man-page archive; skipping man install." 1>&2
        rm -rf "$man_tarball" "$man_stage"
        return 0
    fi
    rm -f "$man_tarball"

    # Decide the target man root:
    #   --man-dir=DIR  → exactly DIR
    #   --system-man   → /usr/local/share/man (escalate with sudo if needed)
    #   (default)      → /usr/local/share/man if writable, else ~/.disc/share/man
    man_sudo=""
    user_local_man=false
    if [ -n "$man_dir" ]; then
        man_target="$man_dir"
    elif [ "$system_man" = "true" ]; then
        man_target="/usr/local/share/man"
    elif mkdir -p "/usr/local/share/man" 2>/dev/null && [ -w "/usr/local/share/man" ]; then
        # `[ -w ]` tests whether we can create *new* entries in the dir. A bare
        # `mkdir -p .../man1` would exit 0 against a pre-existing man1 (e.g. one
        # Homebrew already created) even when the dir is root-owned, then fail
        # later creating the missing man7 — so probe the dir itself, not man1.
        man_target="/usr/local/share/man"
    else
        man_target="$disc_install/share/man"
        user_local_man=true
    fi

    # If the chosen target isn't writable, escalate with sudo when available.
    # Same reasoning as the probe above: check the dir's write bit, not whether
    # `mkdir -p man1` succeeds — otherwise a pre-existing, non-writable man1
    # skips the sudo escalation and the man7 copy fails with Permission denied.
    if ! { mkdir -p "$man_target" 2>/dev/null && [ -w "$man_target" ]; }; then
        if command -v sudo >/dev/null; then
            man_sudo="sudo"
            echo "Installing man pages to $man_target (may prompt for sudo)…"
        else
            echo "Note: $man_target is not writable and sudo is unavailable; skipping man install." 1>&2
            rm -rf "$man_stage"
            return 0
        fi
    fi

    $man_sudo mkdir -p "$man_target/man1" "$man_target/man7"
    for sec in 1 7; do
        if [ -d "$man_stage/man$sec" ]; then
            for page in "$man_stage/man$sec"/*; do
                [ -e "$page" ] || continue
                $man_sudo cp "$page" "$man_target/man$sec/"
            done
        fi
    done
    rm -rf "$man_stage"

    echo "Man pages installed to $man_target"

    # A user-local man root isn't on the default manpath — wire it into the
    # shell rc so `man disc` resolves, unless the caller opted out of rc edits.
    if [ "$user_local_man" = "true" ] && [ "$modify_path" = "true" ]; then
        add_manpath_to_rc "$man_target"
    fi
}

install_man_pages

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
