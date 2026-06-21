/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Disc TypeScript Codegen Module
 */

/*** UTILITY ------------------------------------------ ***/

import * as Context from "../compiler/context.ts";
import * as Types from "./types.ts";

import { getLogger } from "../lib/logger.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { TypeScriptGenerator } from "./typescript-generator.ts";

import type { Module } from "../schema/converter.ts";

const log = getLogger("codegen");

/*** EXPORT ------------------------------------------- ***/

export * from "./types.ts";
export * from "./typescript-generator.ts";

/**
 * Discover schema files in a directory.
 * Priority: *.disc -> *.gel -> *.esdl
 * Returns file paths sorted alphabetically.
 */
export async function discoverSchemaFiles(dir: string): Promise<string[]> {
  const extensions = ["disc", "gel", "esdl"];

  for (const ext of extensions) {
    const files: string[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(`.${ext}`))
          files.push(`${dir}/${entry.name}`);
      }
    } catch {
      /*** Directory doesn’t exist or can’t be read ***/
      continue;
    }

    if (files.length > 0)
      return files.sort();
  }

  return [];
}

/**
 * Generate TypeScript types and client from EdgeQL schema
 */
export function generateTypeScript(schema: Context.Schema, config: Partial<Types.CodegenConfig> = {}): Types.CodegenResult {
  const fullConfig: Types.CodegenConfig = {
    formatOutput: config.formatOutput !== false,
    includeClient: config.includeClient !== false,
    includeMutations: config.includeMutations !== false,
    includeQueryBuilders: config.includeQueryBuilders !== false,
    interfaceSuffix: config.interfaceSuffix || "",
    /*** Default matches the CLI default (./dbschema/disc-client) so calling generateTypeScript()
         with no config produces output in the same place as `disc codegen`. docs/codegen.md and
         docs/getting-started.md both document this path. ***/
    outputDir: config.outputDir || "./dbschema/disc-client",
    schemaSource: config.schemaSource || "./dbschema/default.disc",
    target: config.target || "client",
    typePrefix: config.typePrefix || ""
  };

  const generator = new TypeScriptGenerator(schema, fullConfig);
  return generator.generate();
}

/**
 * Load and merge multiple schema files into a single Schema.
 * Parses each file via SchemaManager, merges Module arrays,
 * then converts to a unified compiler Schema.
 */
export async function loadMultiFileSchema(files: string[]): Promise<Context.Schema> {
  const manager = new SchemaManager({});
  const modules = await loadMultiFileSchemaModules(files);

  return manager.modulesToSchema(modules);
}

/**
 * Load and merge multiple schema files into a Module[] array.
 *
 * Same parse/merge pipeline as `loadMultiFileSchema()` but stops before the
 * Schema conversion. Used by the `migrate` and `serve` paths in `cli/commands.ts`,
 * which feed Module[] directly into `SchemaManager.applyModules()` /
 * `planModules()` so the migration engine sees every cross-module type as
 * resolvable.
 */
export async function loadMultiFileSchemaModules(files: string[]): Promise<Module[]> {
  const allModules: Module[] = [];
  const manager = new SchemaManager({});

  for (const file of files) {
    const source = await Deno.readTextFile(file);
    // Parse only — semantic validation is deferred until the files are merged
    // so a type defined in one file and referenced in another doesn't read as
    // undefined when its file is parsed in isolation.
    const result = manager.parseSDL(source, { validate: false });

    if (!result.ok)
      throw new Error(`Failed to parse ${file}: ${result.error.message}`);

    allModules.push(...result.value);
  }

  const merged = mergeModulesByName(allModules);

  // Validate the complete, merged schema so cross-file references resolve.
  const validation = manager.validateModules(merged);
  if (!validation.ok)
    throw new Error(validation.error.message);

  return merged;
}

/**
 * Write generated files to disk
 */
export async function writeGeneratedFiles(result: Types.CodegenResult, basePath: string = ".", options: { runFmt?: boolean; } = {}): Promise<void> {
  /*** Default: run `deno fmt` over the written files so downstream code matches project
       conventions. Tests that round-trip content verbatim can pass { runFmt: false }. ***/
  const runFmt = options.runFmt ?? true;
  /*** Collect unique directories from file paths ***/
  const dirs = new Set<string>();

  for (const file of result.files) {
    const fullPath = file.path.startsWith("/") ?
      file.path :
      `${basePath}/${file.path}`;

    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));

    if (dir)
      dirs.add(dir);
  }

  /*** Ensure all output directories exist ***/
  for (const dir of dirs) {
    try {
      await Deno.mkdir(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists))
        throw error;
    }
  }

  /*** Write each file ***/
  const writtenPaths: string[] = [];

  for (const file of result.files) {
    const fullPath = file.path.startsWith("/") ?
      file.path :
      `${basePath}/${file.path}`;

    await Deno.writeTextFile(fullPath, file.content);
    writtenPaths.push(fullPath);
    log.info("Generated file", { path: fullPath });
  }

  /*** Run `deno task format` over the written files so generated code matches the project’s
       formatting conventions instead of just stripping blank lines. Best-effort — if deno isn’t on
       PATH or format fails, log and continue; the content is still written. ***/
  if (runFmt && writtenPaths.length > 0) {
    try {
      const cmd = new Deno.Command("deno", {
        // args: ["fmt", "--quiet", ...writtenPaths],
        args: ["task", "format"],
        stderr: "piped",
        stdout: "null"
      });

      const output = await cmd.output();

      if (!output.success) {
        const stderr = new TextDecoder().decode(output.stderr).trim();
        log.warn("deno task format reported issues (generated files still written)", { stderr });
      }
    } catch (error) {
      log.warn("deno task format not available — generated files unformatted", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /*** Report warnings and errors ***/
  if (result.warnings.length > 0)
    result.warnings.forEach(warning => log.warn("Codegen warning", { warning }));

  if (result.errors.length > 0)
    result.errors.forEach(error => log.error("Codegen error", { error }));
}

/**
 * Default codegen configuration for common use cases
 */
export const DEFAULT_CONFIGS = {
  both: (): Partial<Types.CodegenConfig> => ({
    formatOutput: true,
    includeClient: true,
    includeMutations: true,
    includeQueryBuilders: true,
    outputDir: "./generated",
    target: "both"
  }),
  client: (): Partial<Types.CodegenConfig> => ({
    formatOutput: true,
    includeClient: true,
    includeMutations: true,
    includeQueryBuilders: true,
    outputDir: "./generated",
    target: "client"
  }),
  server: (): Partial<Types.CodegenConfig> => ({
    formatOutput: true,
    includeClient: false,
    includeMutations: false,
    includeQueryBuilders: false,
    outputDir: "./src/generated",
    target: "server"
  })
};

/*** HELPER ------------------------------------------- ***/

/**
 * Merge Module[] entries that share the same module name.
 *
 * Multi-file projects commonly split a single logical module across several
 * `.disc` files (e.g. each file declares its own `module default { ... }`
 * block). The migration engine treats Module[] as the source of truth for
 * the post-state, and emits one CreateModule per Module — duplicate names
 * would generate duplicate DDL. Merge by name, preserving declaration order
 * within each module.
 */
function mergeModulesByName(modules: Module[]): Module[] {
  const merged = new Map<string, Module>();

  for (const mod of modules) {
    const existing = merged.get(mod.name);

    if (existing)
      existing.items.push(...mod.items);
    else
      merged.set(mod.name, { items: [...mod.items], name: mod.name });
  }

  return Array.from(merged.values());
}
