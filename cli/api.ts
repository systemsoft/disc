/**
 * Programmatic CLI surface. (gh/geldata#5911)
 *
 * Disc's CLI command logic lives in `cli/commands.ts:CLICommands` so
 * that any `disc <command>` invocation routes through the same code
 * path whether it came from the binary entry point or from a Deno
 * script. This module re-exports the stable subset of that surface
 * along with the well-typed Options interfaces, so users can drive
 * Disc from setup scripts / CI / test fixtures without spawning
 * subprocesses.
 *
 * Usage:
 *
 * ```ts
 * import { CLI } from "disc";
 * await CLI.init({ name: "my-project", template: "basic" });
 * await CLI.migrate({ schema: "./dbschema/default.disc" });
 * await CLI.serve({ port: 5656, requireAuth: true });
 * ```
 *
 * Stability: every exported function has a typed Options interface
 * declared in its source module; the surface here is a re-export, not
 * a wrapper. Adding new commands here is non-breaking; renaming or
 * removing one is a breaking change. Commands that take the bag-style
 * `CLIArgs` (db subcommands, codegen, status, etc.) are intentionally
 * not exposed here — they target operator workflows where the binary
 * entry point with its argv parsing is the right interface.
 *
 * For CI use cases that need to exec the binary, the binary's argv
 * parser lives in `cli/main.ts`; nothing about that path changes.
 */

import { commands } from "./commands.ts";

// Typed Options interfaces — re-exported so callers get IntelliSense
// without reaching into individual command modules.
export type { BuildOptions } from "./build.ts";
export type { ServeOptions } from "./commands.ts";
export type { DeployOptions } from "./deploy.ts";
export type { InitOptions } from "./init.ts";
export type { PgLogOptions } from "./pg-log.ts";
export type { PgUpgradeOptions } from "./pg-upgrade.ts";
export type { ShellOptions } from "./shell.ts";
export type { WatchOptions } from "./watch.ts";

// Imports for the typed function signatures below. Re-exporting types
// happens via `export type` lines above; these `import type` lines
// give the wrapper functions their parameter shapes without paying a
// runtime import cost.
import type { BuildOptions } from "./build.ts";
import type { ServeOptions } from "./commands.ts";
import type { DeployOptions } from "./deploy.ts";
import type { InitOptions } from "./init.ts";
import type { PgLogOptions } from "./pg-log.ts";
import type { PgUpgradeOptions } from "./pg-upgrade.ts";
import type { ShellOptions } from "./shell.ts";
import type { WatchOptions } from "./watch.ts";

/** Initialize a new Disc project. */
export function init(options: InitOptions): Promise<void> {
  return commands.init(options);
}

/** Apply or generate migrations. Pass `{ "dry-run": true }` to skip apply. */
export function migrate(
  options: {
    schema?: string;
    "dry-run"?: boolean;
    "backend-dsn"?: string;
    quiet?: boolean;
  } = {},
): Promise<void> {
  // `migrate` accepts the CLIArgs shape internally (positional `_` carries
  // the subcommand from the binary entry point). For the programmatic
  // surface we synthesize an empty positional list — there is no
  // subcommand when called this way.
  return commands.migrate({ _: [], ...options });
}

/** Start the Disc server (HTTP + EdgeQL + admin UI). */
export function serve(options: ServeOptions): Promise<void> {
  return commands.serve(options);
}

/** Open the interactive EdgeQL REPL. */
export function shell(options: ShellOptions): Promise<void> {
  return commands.shell(options);
}

/** Watch schema files and auto-migrate on change. */
export function watch(options: WatchOptions): Promise<void> {
  return commands.watch(options);
}

/** Compile Disc into a self-contained binary. */
export function build(options: BuildOptions): Promise<void> {
  return commands.build(options);
}

/** Generate deployment artifacts (Dockerfile, compose, systemd, env). */
export function deploy(options: DeployOptions): Promise<void> {
  return commands.deploy(options);
}

/** Tail PostgreSQL logs. */
export function pgLog(options: PgLogOptions): Promise<void> {
  return commands.pgLog(options);
}

/** Upgrade the bundled PostgreSQL version. */
export function pgUpgrade(options: PgUpgradeOptions): Promise<void> {
  return commands.pgUpgrade(options);
}
