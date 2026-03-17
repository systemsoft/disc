// deno-lint-ignore-file no-console
import { EdgeQLParser } from "./edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler/compiler.ts";
import { SQLCodeGenerator } from "./compiler/codegen.ts";
import { createTestSchema } from "./compiler/context.ts";

const schema = createTestSchema();
const compiler = new EdgeQLCompiler(schema);
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }

  return codegen.generate(result.value);
}

const source = "SELECT User";
const sql = compileEdgeQL(source);

console.log("Generated SQL:");
console.log(sql);
console.log("");
console.log("Contains SELECT:", sql.includes("SELECT"));
console.log("Contains jsonb_build_object:", sql.includes("jsonb_build_object"));
console.log("Contains FROM users:", sql.includes("FROM users"));
