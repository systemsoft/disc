/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * The Ende release Disc is built and tested on. CI, the release workflow,
 * both Dockerfiles and the `disc deploy` Dockerfile template install this
 * exact version; `lib/runtime.test.ts` fails if any of them drifts.
 */
export const ENDE_VERSION = "v2026.10.20";

/**
 * Which JavaScript runtime binaries to spawn for toolchain subcommands
 * (`compile`, `fmt`), in the order to try them.
 *
 * From source, that is whatever is running Disc right now, so
 * `Deno.execPath()` is used rather than a hardcoded name. A compiled `disc`
 * binary *is* the runtime (`execPath()` points at `disc` itself), so there
 * the toolchain has to come from PATH: Ende first, since Disc is built on it,
 * then Deno, which users' projects may run on instead (both read the
 * `deno.json` that `disc init` writes).
 */
export function runtimeExecutables(standalone: boolean = Deno.build.standalone): string[] {
  return standalone ? ["ende", "deno"] : [Deno.execPath()];
}
