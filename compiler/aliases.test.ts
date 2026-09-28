/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Aliases are their expressions (compiler/aliases.ts): an alias of a type's
 * objects is a view type with its shape's computeds, any other is a `with`
 * binding of its expression ahead of the query naming it.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { modulesToSchema } from "../migration/runtime-schema.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { inferOutputShape } from "../protocol/binary-server.ts";
import { bindAliases } from "./aliases.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `module default {
  type U {
    required name: str;
    tier: str;
  };
  alias Tiers := U.tier union 'none';
  alias Named := U { name, loud := str_upper(.name) };
  alias People := U;
  alias Loud := (select Named filter .loud != 'X');
  alias Counted := count(Tiers);
}`;

function schema(): Schema {
  const parsed = new SchemaManager({ dryRun: true }).parseSDL(SDL);
  assert(parsed.ok, parsed.ok ? "" : parsed.error.message);
  return modulesToSchema(parsed.value);
}

function sql(edgeql: string): string {
  const result = new EdgeQLCompiler(schema(), {}).compile(new EdgeQLParser(edgeql).parse());
  assert(result.ok, result.ok ? "" : result.error.message);
  return new SQLCodeGenerator().generate(result.value);
}

Deno.test("aliases - an alias of values is a with binding of its expression", () => {
  const { query } = bindAliases(new EdgeQLParser("select Tiers").parse(), schema());
  assertEquals(query.kind, "WithBlock");
  const block = query as EdgeQLAST.WithBlock;
  assertEquals(block.bindings.map(binding => binding.name.name), ["__alias_Tiers"]);
  assertEquals(((block.body as EdgeQLAST.SelectQuery).expr as EdgeQLAST.Identifier).name, "__alias_Tiers");
  assertStringIncludes(sql("select Tiers"), "UNION ALL");
});

Deno.test("aliases - an alias of a type's shaped objects is a view type with its computeds", () => {
  const bound = bindAliases(new EdgeQLParser("select Named { loud }").parse(), schema());
  const view = bound.schema.types.get("Named");
  assertEquals(view?.tableName, "u");
  assertEquals(view?.properties.get("loud")?.computedExpr, "str_upper(.name)");
  assertEquals(view?.properties.get("loud")?.edgeqlType, "str");
  assertStringIncludes(sql("select Named { loud } filter .loud = 'A'"), "UPPER(");
  // The schema the compiler was given is left as it was.
  assertEquals(schema().types.has("Named"), false);
});

Deno.test("aliases - an alias naming another is bound after it", () => {
  const { query } = bindAliases(new EdgeQLParser("select Counted").parse(), schema());
  assertEquals((query as EdgeQLAST.WithBlock).bindings.map(binding => binding.name.name), ["__alias_Tiers", "__alias_Counted"]);
  sql("select Loud { name, loud }");
  sql("select People { name }");
});

Deno.test("aliases - a name a with binding binds is the binding's", () => {
  const query = new EdgeQLParser("with Tiers := {'a'} select Tiers").parse();
  assertEquals(bindAliases(query, schema()).query, query);
});

Deno.test("aliases - a binary result descriptor describes the alias's values", () => {
  const { query, schema: bound } = bindAliases(new EdgeQLParser("select Tiers").parse(), schema());
  const shape = inferOutputShape(query, bound, { aliases: new Map() });
  assertEquals(shape.typeName, "str");
  const named = bindAliases(new EdgeQLParser("select Named { loud }").parse(), schema());
  assertEquals(inferOutputShape(named.query, named.schema, { aliases: new Map() }).fields.map(field => field.edgeqlType), ["str"]);
});
