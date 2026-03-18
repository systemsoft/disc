/**
 * Disc TypeScript Codegen Module
 */

export * from "./types.ts";
export * from "./typescript-generator.ts";

import * as Context from "../compiler/context.ts";
import { getLogger } from "../lib/logger.ts";
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
    schemaSource: config.schemaSource || "./schema.esdl",
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
): Promise<void> {
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
  for (const file of result.files) {
    const fullPath = file.path.startsWith("/")
      ? file.path
      : `${basePath}/${file.path}`;
    await Deno.writeTextFile(fullPath, file.content);
    log.info("Generated file", { path: fullPath });
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
