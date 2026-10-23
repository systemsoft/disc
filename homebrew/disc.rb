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
  version "2026.09.28"
  license "Apache-2.0"

  on_macos do
    depends_on arch: :arm64

    on_arm do
      url "https://github.com/systemsoft/disc/releases/download/v#{version}/disc-darwin-arm64"
      sha256 "0cd284795b23d40bb39cc893268bca0e5c17a90111033a299a53e60d1be67144"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/systemsoft/disc/releases/download/v#{version}/disc-linux-arm64"
      sha256 "88203a3cf500d50f321441a3cba15efba2cc3851d4cd6cb62c36330a10026913"
    end

    on_intel do
      url "https://github.com/systemsoft/disc/releases/download/v#{version}/disc-linux-x64"
      sha256 "dd892ce611a7008d72a8759bada7c99dd72a68941a65e3aaacf42b2f07be42ba"
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
