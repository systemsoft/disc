# Homebrew Formula for Disc
#
# Published tap: github.com/systemsoft/homebrew-disc/Formula/disc.rb
# (copy this file there on each release).
#
# Install notes:
#   - Installs the prebuilt `disc` binary that `.github/workflows/release.yml`
#     publishes for each tag, verified against its SHA-256. No JavaScript
#     runtime or Bun is needed: the binary embeds the Ende runtime, the UI and
#     PostgreSQL.
#   - macOS is Apple Silicon only, matching the release matrix. Intel Macs are
#     not supported: Ende, the runtime Disc is built on, has no darwin-x64 build.
#   - To bump: set `version`, then replace each `sha256` with the matching
#     line of the release's CHECKSUMS.txt.

class Disc < Formula
  desc "TypeScript-native, schema-first database (Gel/EdgeDB compatible)"
  homepage "https://disc.sh"
  version "2026.10.23"
  license "Apache-2.0"

  on_macos do
    depends_on arch: :arm64

    on_arm do
      url "https://github.com/systemsoft/disc/releases/download/v#{version}/disc-darwin-arm64"
      sha256 "0b9e9b04a01a8df9514a5111228b954ad5bc994f8d88d144c98045e7dc958f6e"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/systemsoft/disc/releases/download/v#{version}/disc-linux-arm64"
      sha256 "0534db37db32816a11c1dcb441a68b52e32f2eaf080b672a71aa8d87f95a0972"
    end

    on_intel do
      url "https://github.com/systemsoft/disc/releases/download/v#{version}/disc-linux-x64"
      sha256 "7ef200287d4261af691ff9f23d401773a7fb591d7cb9f67f6240ae7896b86652"
    end
  end

  def install
    # The download is the bare executable, named after its platform.
    bin.install Dir["disc-*"].first => "disc"
  end

  test do
    # `disc --version` must exit 0 and print a version string. This is
    # the same smoke test `cli/binary-integration.test.ts` runs.
    output = shell_output("#{bin}/disc --version")
    assert_match(/\d+\.\d+\.\d+/, output)
  end
end
