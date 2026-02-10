/**
 * Disc TypeScript Codegen Module
 */

export * from "./types.ts";
export * from "./typescript-generator.ts";

import * as Context from "../compiler/context.ts";
import { TypeScriptGenerator } from "./typescript-generator.ts";
import * as Types from "./types.ts";

/**
 * Generate TypeScript types and client from EdgeQL schema
 */
export function generateTypeScript(
  schema: Context.Schema,
  config: Partial<Types.CodegenConfig> = {}
): Types.CodegenResult {
  const fullConfig: Types.CodegenConfig = {
    output_dir: config.output_dir || "./generated",
    schema_source: config.schema_source || "./schema.esdl",
    target: config.target || "client",
    type_prefix: config.type_prefix || "",
    interface_suffix: config.interface_suffix || "",
    include_query_builders: config.include_query_builders !== false,
    include_mutations: config.include_mutations !== false,
    include_client: config.include_client !== false,
    format_output: config.format_output !== false,
  };

  const generator = new TypeScriptGenerator(schema, fullConfig);
  return generator.generate();
}

/**
 * Write generated files to disk
 */
export async function writeGeneratedFiles(
  result: Types.CodegenResult,
  basePath: string = "."
): Promise<void> {
  // Ensure output directory exists
  const outputDir = `${basePath}/${result.files[0]?.path?.split("/")[0] || "generated"}`;
  
  try {
    await Deno.mkdir(outputDir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      throw error;
    }
  }

  // Write each file
  for (const file of result.files) {
    const fullPath = `${basePath}/${file.path}`;
    await Deno.writeTextFile(fullPath, file.content);
    console.log(`✅ Generated: ${fullPath}`);
  }

  // Report warnings and errors
  if (result.warnings.length > 0) {
    console.log(`⚠️  Warnings:`);
    result.warnings.forEach(warning => console.log(`   ${warning}`));
  }

  if (result.errors.length > 0) {
    console.log(`❌ Errors:`);
    result.errors.forEach(error => console.log(`   ${error}`));
  }
}

/**
 * Default codegen configuration for common use cases
 */
export const DEFAULT_CONFIGS = {
  client: (): Partial<Types.CodegenConfig> => ({
    target: "client",
    output_dir: "./generated",
    include_query_builders: true,
    include_client: true,
    include_mutations: true,
    format_output: true,
  }),

  server: (): Partial<Types.CodegenConfig> => ({
    target: "server",
    output_dir: "./src/generated",
    include_query_builders: false,
    include_client: false,
    include_mutations: false,
    format_output: true,
  }),

  both: (): Partial<Types.CodegenConfig> => ({
    target: "both",
    output_dir: "./generated",
    include_query_builders: true,
    include_client: true,
    include_mutations: true,
    format_output: true,
  }),
};