# Homebrew distribution for Disc

This directory ships the Homebrew Formula that lets macOS and Linux users install Disc with `brew install`. The Formula source is `disc.rb`.

## For users — installing Disc via Homebrew

> The standard Homebrew tap repo (`github.com/systemsoft/homebrew-disc`) has not been published yet. Until it exists, install via the direct-formula path below.

### Option A — install from this repo's primary branch (cutting-edge)

```bash
brew install --HEAD https://raw.githubusercontent.com/systemsoft/disc/primary/homebrew/disc.rb
```

This builds Disc from the latest `primary` HEAD via `deno compile`. Build time is ~30 seconds on a modern Mac and depends on `deno` and `bun` (Homebrew installs them automatically).

### Option B — install from the latest tagged release (stable)

```bash
brew install https://raw.githubusercontent.com/systemsoft/disc/primary/homebrew/disc.rb
```

This pins to whichever tag the Formula's `url`/`sha256` block currently references. Update the Formula in lockstep with each tagged release.

### After install

The `disc` binary is on your PATH:

```bash
disc --version
disc init my-app
cd my-app
disc serve
```

PostgreSQL is downloaded automatically on first `disc init` or `disc serve` — the brew-built binary intentionally doesn't embed PG (see "Build notes" below).

## For maintainers — publishing the tap

The end-state is a separate `github.com/systemsoft/homebrew-disc` repo at `Formula/disc.rb`. The migration is:

1. Create the public repo `homebrew-disc` under the `systemsoft` org.
2. Copy `disc.rb` from this directory into `Formula/disc.rb` in that repo.
3. Tag the disc repo with a stable release (e.g. `v2026.05.04`), download the auto-generated tarball, compute its SHA256, and update the Formula's `sha256` line to replace the `REPLACE_WITH_TAG_SHA256_AT_PUBLISH_TIME` placeholder.
4. Push the tap repo. Users can then install via:
   ```bash
   brew tap systemsoft/disc
   brew install disc
   ```
5. Going forward, every Disc tag should bump `version`/`url`/`sha256` in the tap's `Formula/disc.rb` (a one-line `brew bump-formula-pr` invocation handles this from the tap repo's `main`).

This `homebrew/disc.rb` file in the main disc repo stays as the canonical source — copy it into the tap repo when bumping versions.

## Build notes

- **No GitHub release artifacts yet.** A bottle Formula (downloads pre-built per-platform binaries with SHA256 verification) would be the user-friendliest path but requires publishing per-platform binaries to GH releases first. The current Formula builds from source at install time.
- **PG isn't bundled in the brew-built binary.** The build machine has no `<DISC_HOME>/postgres/<version>/` cache, so the embedded-PG manifest is empty. The runtime downloads PG on first `disc init` or `disc serve` — same as `DISC_BUILD_NO_BUNDLE_PG=1`.
- **UI IS bundled.** The Formula runs `bun run build` first so the embedded asset manifest is non-empty and `disc ui` / the SPA path both work.

## Testing the formula locally

From a clone of the disc repo:

```bash
brew install --HEAD ./homebrew/disc.rb
disc --version
brew uninstall disc
```

Or run `brew test disc` after install to exercise the embedded `test do` block.
