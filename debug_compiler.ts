// deno-lint-ignore-file no-console
import { EdgeQLParser } from "./edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler/compiler.ts";
import { SQLCodeGenerator } from "./compiler/codegen.ts";
import { createTestSchema } from "./compiler/context.ts";

const schema = createTestSchema();
const compiler = new EdgeQLCompiler(schema);
const codegen = new SQLCodeGenerator();

function testCompile(source: string) {
  console.log("EdgeQL:", source);
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();
  console.log("AST:", JSON.stringify(ast, null, 2));

  const result = compiler.compile(ast);
  if (!result.ok) {
    console.log("Error:", result.error.message);
    return;
  }

  console.log("SQL AST:", JSON.stringify(result.value, null, 2));
  const sql = codegen.generate(result.value);
  console.log("Generated SQL:", sql);
}

testCompile("SELECT User");
