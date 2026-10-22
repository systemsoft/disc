/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Which JavaScript runtime binary to spawn for toolchain subcommands
 * (`compile`, `fmt`).
 *
 * From source, that is whatever is running Disc right now — `deno` or
 * `ende` (Ende is a Deno fork with the same subcommands) — so
 * `Deno.execPath()` is used rather than a hardcoded name. A compiled `disc`
 * binary *is* the runtime (`execPath()` points at `disc` itself), so there
 * the toolchain has to come from PATH.
 */
export function runtimeExecutable(standalone: boolean = Deno.build.standalone): string {
  return standalone ? "deno" : Deno.execPath();
}
