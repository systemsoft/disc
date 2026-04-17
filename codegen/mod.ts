/**
 * Disc TypeScript Codegen Module
 */

export * from "./types.ts";
export * from "./typescript-generator.ts";

import * as Context from "../compiler/context.ts";
import { getLogger } from "../lib/logger.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import type { Module } from "../schema/converter.ts";
import { TypeScriptGenerator } from "./typescript-generator.ts";
import * as Types from "./types.ts";

const log = getLogger("codegen");

/**
 * Generate TypeScript types and client from EdgeQL schema
 */
export function generateTypeScript(
  schema: Context.Schema,
  config: Partial<Types.CodegenConfig> = {},
): Types.CodegenResult {
  const fullConfig: Types.CodegenConfig = {
    outputDir: config.outputDir || "./generated",
    schemaSource: config.schemaSource || "./schema.disc",
    target: config.target || "client",
    typePrefix: config.typePrefix || "",
    interfaceSuffix: config.interfaceSuffix || "",
    includeQueryBuilders: config.includeQueryBuilders !== false,
    includeMutations: config.includeMutations !== false,
    includeClient: config.includeClient !== false,
    formatOutput: config.formatOutput !== false,
  };

  const generator = new TypeScriptGenerator(schema, fullConfig);
  return generator.generate();
}

/**
 * Write generated files to disk
 */
export async function writeGeneratedFiles(
  result: Types.CodegenResult,
  basePath: string = ".",
  options: { runFmt?: boolean } = {},
): Promise<void> {
  // Default: run `deno fmt` over the written files so downstream code
  // matches project conventions. Tests that round-trip content verbatim
  // can pass { runFmt: false }. (P1-22)
  const runFmt = options.runFmt ?? true;
  // Collect unique directories from file paths
  const dirs = new Set<string>();
  for (const file of result.files) {
    const fullPath = file.path.startsWith("/")
      ? file.path
      : `${basePath}/${file.path}`;
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dir) dirs.add(dir);
  }

  // Ensure all output directories exist
  for (const dir of dirs) {
    try {
      await Deno.mkdir(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw error;
      }
    }
  }

  // Write each file
  const writtenPaths: string[] = [];
  for (const file of result.files) {
    const fullPath = file.path.startsWith("/")
      ? file.path
      : `${basePath}/${file.path}`;
    await Deno.writeTextFile(fullPath, file.content);
    writtenPaths.push(fullPath);
    log.info("Generated file", { path: fullPath });
  }

  // P1-22: run `deno fmt` over the written files so generated code matches
  // the project's formatting conventions instead of just stripping blank
  // lines. Best-effort — if deno isn't on PATH or fmt fails, log and
  // continue; the content is still written.
  if (runFmt && writtenPaths.length > 0) {
    try {
      const cmd = new Deno.Command("deno", {
        args: ["fmt", "--quiet", ...writtenPaths],
        stdout: "null",
        stderr: "piped",
      });
      const output = await cmd.output();
      if (!output.success) {
        const stderr = new TextDecoder().decode(output.stderr).trim();
        log.warn("deno fmt reported issues (generated files still written)", {
          stderr,
        });
      }
    } catch (error) {
      log.warn("deno fmt not available — generated files unformatted", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Report warnings and errors
  if (result.warnings.length > 0) {
    result.warnings.forEach((warning) =>
      log.warn("Codegen warning", { warning })
    );
  }

  if (result.errors.length > 0) {
    result.errors.forEach((error) => log.error("Codegen error", { error }));
  }
}

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
      // Directory doesn't exist or can't be read
      continue;
    }

    if (files.length > 0)
      return files.sort();
  }

  return [];
}

/**
 * Load and merge multiple schema files into a single Schema.
 * Parses each file via SchemaManager, merges Module arrays,
 * then converts to a unified compiler Schema.
 */
export async function loadMultiFileSchema(files: string[]): Promise<Context.Schema> {
  const manager = new SchemaManager({});
  const allModules: Module[] = [];

  for (const file of files) {
    const source = await Deno.readTextFile(file);
    const result = manager.parseSDL(source);

    if (!result.ok)
      throw new Error(`Failed to parse ${file}: ${result.error.message}`);

    allModules.push(...result.value);
  }

  return manager.modulesToSchema(allModules);
}

/**
 * Default codegen configuration for common use cases
 */
export const DEFAULT_CONFIGS = {
  client: (): Partial<Types.CodegenConfig> => ({
    target: "client",
    outputDir: "./generated",
    includeQueryBuilders: true,
    includeClient: true,
    includeMutations: true,
    formatOutput: true,
  }),

  server: (): Partial<Types.CodegenConfig> => ({
    target: "server",
    outputDir: "./src/generated",
    includeQueryBuilders: false,
    includeClient: false,
    includeMutations: false,
    formatOutput: true,
  }),

  both: (): Partial<Types.CodegenConfig> => ({
    target: "both",
    outputDir: "./generated",
    includeQueryBuilders: true,
    includeClient: true,
    includeMutations: true,
    formatOutput: true,
  }),
};
