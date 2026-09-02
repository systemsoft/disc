/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Generate man pages from the published documentation using pandoc.
 *
 * The user-facing guides live in the documentation site repo
 * (github.com/systemsoft/disc.md, rendered at https://disc.md) and are
 * vendored here as a git submodule at `vendor/disc.md`, pinned to a commit.
 * That keeps a single source of truth for prose while still letting a release
 * ship man pages that match a known documentation revision — and keeps
 * generation hermetic and offline-capable, unlike fetching at build time.
 *
 * `documents/cli.md` becomes the canonical `disc(1)` page; every other guide
 * becomes a section-7 `disc-<name>(7)` overview page. Output lands in
 * `build/man/man1` and `build/man/man7`, ready to be packaged (`just man`)
 * and installed to the system man location by `install.sh`.
 *
 * Note `docs/` in this repo is NOT the source: it retains only
 * maintainer-internal material (e.g. `future-triage.md`, referenced by
 * `tests/gel-divergence-pins.test.ts` and `migration/gel-issues.test.ts`)
 * which is deliberately not published.
 *
 * Requires `pandoc` on PATH. Invoked by `deno task man` / `just man`, which
 * `just release` runs after the binary build.
 */

import { ensureDir } from "@std/fs";
import { join } from "@std/path";

const DOCS_DIR = "vendor/disc.md/documents";
const OUT_DIR = "build/man";

/**
 * Published guides that are not user-facing command reference — skipped.
 * Everything else under `DOCS_DIR` is rendered to a man page.
 */
const SKIP = new Set([
  "releasing.md" // maintainer release process
]);

const encoder = new TextEncoder();
function info(message: string): void {
  Deno.stderr.writeSync(encoder.encode(`${message}\n`));
}

async function pandocExists(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("pandoc", {
      args: ["--version"],
      stdout: "null",
      stderr: "null"
    })
      .output();
    return success;
  } catch {
    return false;
  }
}

async function renderManPage(
  source: string,
  output: string,
  title: string,
  section: string,
  version: string
): Promise<void> {
  const { success, stderr } = await new Deno.Command("pandoc", {
    args: [
      "--standalone",
      "--from",
      "gfm",
      "--to",
      "man",
      "--metadata",
      `title=${title}`,
      "--metadata",
      `section=${section}`,
      "--metadata",
      `date=${version}`,
      "--metadata",
      "header=Disc Manual",
      "--metadata",
      `footer=disc ${version}`,
      source,
      "--output",
      output
    ],
    stdout: "null",
    stderr: "piped"
  })
    .output();

  if (!success) {
    throw new Error(
      `pandoc failed for ${source}:\n${new TextDecoder().decode(stderr)}`
    );
  }
}

if (!(await pandocExists())) {
  info(
    "[ERROR] pandoc is required to generate man pages but was not found on PATH.\n" +
      "        Install it (e.g. `brew install pandoc`, `apt install pandoc`) and retry."
  );
  Deno.exit(1);
}

/**
 * A fresh `git clone` without `--recursive` leaves `vendor/disc.md` present
 * but empty, which would otherwise render zero man pages and ship a release
 * with an empty `disc-man.tar.gz`. Fail loudly with the fix instead.
 */
async function docsAvailable(): Promise<boolean> {
  try {
    for await (const entry of Deno.readDir(DOCS_DIR)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

if (!(await docsAvailable())) {
  info(
    `[ERROR] No Markdown guides found in ${DOCS_DIR}.\n` +
      "        Documentation lives in the disc.md submodule. Initialize it:\n" +
      "          git submodule update --init vendor/disc.md"
  );
  Deno.exit(1);
}

const version = (await Deno.readTextFile("version.txt")).trim();

const man1 = join(OUT_DIR, "man1");
const man7 = join(OUT_DIR, "man7");
await ensureDir(man1);
await ensureDir(man7);

const docs: string[] = [];
for await (const entry of Deno.readDir(DOCS_DIR)) {
  if (entry.isFile && entry.name.endsWith(".md") && !SKIP.has(entry.name)) {
    docs.push(entry.name);
  }
}
docs.sort();

let count = 0;
for (const doc of docs) {
  const name = doc.slice(0, -".md".length);
  const source = join(DOCS_DIR, doc);

  if (doc === "cli.md") {
    const output = join(man1, "disc.1");
    await renderManPage(source, output, "DISC", "1", version);
    info(`  ${source} → ${output}`);
  } else {
    const output = join(man7, `disc-${name}.7`);
    await renderManPage(source, output, `DISC-${name.toUpperCase()}`, "7", version);
    info(`  ${source} → ${output}`);
  }
  count++;
}

info(`[INFO] Generated ${count} man page(s) → ${OUT_DIR}`);
