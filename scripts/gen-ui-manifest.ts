/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Regenerate `server/ui-asset-manifest.ts` from the current `ui/build/`.
 *
 * `ui/build/` is gitignored and rebuilt from source; the manifest derived
 * from it — naming every content-hashed asset — is checked in, because the
 * asset handler consults it before serving and callers shouldn't need a
 * build to use the handler in tests. A UI change that doesn't reach the
 * manifest therefore makes the handler 404 files whose bytes are on disk
 * (`cli/build.test.ts` guards this).
 *
 * `disc build` already reconciles the manifest, but going through it costs a
 * full ~215MB `deno compile` for what is really a directory listing. This
 * script does only the regeneration, so `just ui-build` stays cheap.
 *
 * Run `bash ui/build.sh` first — this reads whatever is on disk, and will
 * refuse to write an empty manifest.
 *
 * Invoked by `deno task ui:manifest` / `just ui-build`.
 */

import { generateUiManifest } from "../cli/build.ts";

const BUILD_DIR = "ui/build";
const MANIFEST_PATH = "server/ui-asset-manifest.ts";

const source = await generateUiManifest(BUILD_DIR);
await Deno.writeTextFile(MANIFEST_PATH, source);
