# Releasing Disc

Disc uses [ChronVer](https://chronver.org) (`YYYY.MM.DD`) for release
versioning. `version.txt` at the repo root is the single source of
truth, consumed by `mod.ts` at runtime and bundled into compiled
binaries via `--include version.txt`.

## One-time setup

- You need push access to the `primary` branch and permission to create
  tags on `github.com:systemsoft/disc`.
- GitHub Actions must be enabled for the repo (the `Release` workflow
  runs on tag push).

## Cutting a release

```bash
# 1. Land everything you want shipped on primary and make sure CI is green.
git checkout primary && git pull

# 2. Bump version.txt to today's date (ChronVer via justfile task).
just version
# → writes YYYY.MM.DD, e.g. 2026.04.17

# 3. Commit and tag.
VERSION=$(cat version.txt)
git commit -am "Release $VERSION"
git tag "v$VERSION"

# 4. Push commit and tag together.
git push origin primary --tags
```

Pushing the tag triggers `.github/workflows/release.yml`, which:

1. Builds native binaries for `linux-x64`, `linux-arm64`,
   `darwin-arm64`, and `windows-x64` (UI is bundled via `bun run build` +
   `disc build`). The `windows-x64` binary is cross-compiled on the Linux
   runner — `deno compile --target x86_64-pc-windows-msvc` plus the PG
   staging extract chain (unzip + xz) both run there — and ships as
   `disc-windows-x64.exe`.
2. Computes `sha256` checksums.
3. Publishes a GitHub release named `v$VERSION` with the four binaries,
   a `CHECKSUMS.txt` file, and auto-generated release notes.

> **`darwin-x64` is not in the release matrix.** The macos-13 GitHub-hosted
> runner hangs indefinitely on the build step, so we don't ship a pre-built
> Intel-Mac binary. Platform support stays in the CLI — Intel-Mac users can
> build from source via `deno task build:darwin-x64`, or run the `darwin-arm64`
> binary under Rosetta. Re-introducing the matrix entry would require fixing
> the runner hang first.

## Verifying a release

Users verify a downloaded binary:

```bash
shasum -a 256 disc-darwin-arm64
# Compare against CHECKSUMS.txt on the release page.
```

Inside the binary, `disc --version` reports the ChronVer string read
from the embedded `version.txt`.

## Rolling back

Releases can't be unpublished — delete the GitHub release + tag and
publish a follow-up with a later ChronVer date:

```bash
git tag -d "v$OLD_VERSION"
git push origin ":refs/tags/v$OLD_VERSION"
# Cut a new release with today's date.
```

## Pre-release / manual dispatch

The release workflow supports `workflow_dispatch` so you can rebuild
a previously-tagged version without re-tagging (useful if the workflow
itself changed):

```
GitHub → Actions → Release → Run workflow → input: v2026.04.17
```

## Signing (future)

Binary signing is not yet configured. Until then, the SHA-256
checksum in the release notes is the integrity anchor. macOS users
wanting Gatekeeper-friendly binaries should `codesign` locally.
