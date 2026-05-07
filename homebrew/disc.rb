# Homebrew Formula for Disc
#
# Standard tap location after publication:
#   github.com/systemsoft/homebrew-disc/Formula/disc.rb
#
# Until the tap repo exists, this formula can be installed directly from the
# main repo for early adopters:
#   brew install --HEAD https://raw.githubusercontent.com/systemsoft/disc/primary/homebrew/disc.rb
#
# Build path notes:
#   - Builds Disc from source via `deno compile` (no GitHub release artifacts
#     yet — bottle support waits on a published release pipeline).
#   - The brew-built binary does NOT bundle PostgreSQL: the build machine
#     has no `<DISC_HOME>/postgres/<version>/` cache, so the embedded-PG
#     manifest is empty and the runtime falls back to the network downloader
#     on first `disc init` / `disc serve`. This matches `DISC_BUILD_NO_BUNDLE_PG=1`
#     behavior and keeps the formula's brew install footprint small.
#   - The UI IS bundled (the formula's build steps run `bun run build` first
#     so `server/ui-assets.test.ts` and the runtime SPA path both work).

class Disc < Formula
  desc "TypeScript-native, schema-first database (Gel/EdgeDB compatible)"
  homepage "https://github.com/systemsoft/disc"
  license "AGPL-3.0-or-later"

  # Stable: tagged release. Update on each new tag.
  url "https://github.com/systemsoft/disc/archive/refs/tags/v2026.05.04.tar.gz"
  sha256 "REPLACE_WITH_TAG_SHA256_AT_PUBLISH_TIME"
  version "2026.05.04"

  # Cutting-edge: install from `primary` branch via `brew install --HEAD disc`.
  # Useful while bundles ship faster than tags.
  head "https://github.com/systemsoft/disc.git", branch: "primary"

  depends_on "deno"
  depends_on "oven-sh/bun/bun"

  def install
    # Build the SvelteKit UI so the embedded asset manifest is non-empty.
    cd "ui" do
      system "bun", "install", "--frozen-lockfile"
      system "bun", "run", "build"
    end

    # Compile the Disc binary. `DISC_BUILD_NO_BUNDLE_PG=1` skips the PG
    # cache walk explicitly — the brew machine wouldn't have one anyway,
    # but setting the var avoids a misleading "no embedded PG (no cache
    # at <path>)" log line during the build.
    ENV["DISC_BUILD_NO_BUNDLE_PG"] = "1"
    system "deno", "task", "build"

    # Install the produced binary to the Homebrew-managed bin path.
    bin.install "disc"
  end

  test do
    # `disc --version` must exit 0 and print a version string. This is
    # the same smoke test `cli/binary-integration.test.ts` runs.
    output = shell_output("#{bin}/disc --version")
    assert_match(/\d+\.\d+\.\d+/, output)
  end
end
