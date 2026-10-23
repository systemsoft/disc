# Homebrew distribution for Disc

This directory ships the Homebrew Formula that lets macOS and Linux users install Disc with `brew install`. The Formula source is `disc.rb`.

## For users — installing Disc via Homebrew

```bash
brew tap systemsoft/disc
brew install disc
```

This installs the prebuilt `disc` binary for your platform from the tagged GitHub release, checked against its SHA-256. Nothing else is installed: the binary already embeds the Ende runtime, the admin UI and PostgreSQL.

Supported platforms match the release matrix: macOS on Apple Silicon, and Linux on x64 and arm64. On an Intel Mac, use the `install.sh` script from the main README, or build from source with `ende task build`.

### After install

The `disc` binary is on your PATH:

```bash
disc --version
disc init my-app
cd my-app
disc serve
```

## For maintainers — releasing to the tap

The tap lives at `github.com/systemsoft/homebrew-disc` in `Formula/disc.rb`. This `homebrew/disc.rb` file in the main disc repo is the canonical source.

After each tagged release (once `release.yml` has published the binaries):

1. Set `version` in `disc.rb` to the new release.
2. Replace each platform's `sha256` with its line from the release's `CHECKSUMS.txt`.
3. Copy `disc.rb` into the tap's `Formula/disc.rb` and push.

## Testing the formula locally

Homebrew only installs formulae from a tap, so test through a throwaway local one:

```bash
brew tap-new local/disc-test --no-git
cp homebrew/disc.rb "$(brew --repository local/disc-test)/Formula/disc.rb"
brew install local/disc-test/disc
brew test local/disc-test/disc
brew uninstall local/disc-test/disc && brew untap local/disc-test
```
