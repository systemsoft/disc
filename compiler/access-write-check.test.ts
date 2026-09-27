/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Where the check on written objects (insert / update write policies) sits in
 * the compiled SQL: every insert and update of a type with policies reads its
 * RETURNING rows through `disc_access_check`, wherever the mutation is
 * compiled; a type without policies and a bypass caller get the statement
 * they always had. End-to-end behaviour: pg-access-policy-writes.test.ts.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { AccessContext } from "../access/types.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Owned {
    required title: str;
    owner: uuid;
    access policy own {
      allow all;
      using (.owner ?= global current_user);
    };
  }
  type Holder {
    required name: str;
    item: Owned;
  }
}
`;

const USER_ID = "01234567-89ab-7cde-8f01-000000000001";
const CHECK = `disc_access_check(COALESCE((__policy_rows.owner IS NOT DISTINCT FROM E'${USER_ID}'), FALSE), E'access policy violation on`;

async function testSchema(): Promise<Schema> {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  const parsed = manager.parseSDL(SDL);
  if (!parsed.ok) {
    throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
  }
  return manager.modulesToSchema(parsed.value);
}

async function compile(edgeql: string, context: AccessContext | undefined): Promise<string> {
  const schema = await testSchema();
  const compiler = new EdgeQLCompiler(schema, {
    accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
    enableAccessControl: context !== undefined
  });
  for (const typeDef of schema.types.values()) {
    for (const policy of typeDef.accessPolicies ?? []) {
      compiler.registerAccessPolicy(policy);
    }
  }
  compiler.setAccessContext(context ?? {});
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  assert(result.ok, `compile failed for ${edgeql}: ${result.ok ? "" : result.error.message}`);
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

Deno.test("write check - inserts and updates of a policied type check what they write", async () => {
  const insert = await compile(`insert Owned { title := 't', owner := <uuid>'${USER_ID}' }`, { userId: USER_ID });
  assertStringIncludes(
    insert,
    `RETURNING (CASE WHEN (SELECT ${CHECK} insert of default::Owned') FROM (SELECT "owned".*) AS "__policy_rows") THEN owned END).*`
  );

  const update = await compile("update Owned set { title := 'u' }", { userId: USER_ID });
  assertStringIncludes(update, `${CHECK} update of default::Owned')`);

  // A bulk insert returns only ids, read from the checked row.
  const bulk = await compile("for t in {'a', 'b'} union (insert Owned { title := t })", { userId: USER_ID });
  assertStringIncludes(bulk, `${CHECK} insert of default::Owned')`);

  const forUpdate = await compile("for o in Owned union (update o set { title := 'x' })", { userId: USER_ID });
  assertStringIncludes(forUpdate, `${CHECK} update of default::Owned')`);
});

Deno.test("write check - a nested insert in a link assignment is checked", async () => {
  const sql = await compile("insert Holder { name := 'h', item := (insert Owned { title := 't' }) }", { userId: USER_ID });
  assertStringIncludes(sql, `${CHECK} insert of default::Owned')`);
});

Deno.test("write check - a type without policies and a bypass caller compile as without access control", async () => {
  for (const edgeql of ["insert Holder { name := 'h' }", "update Holder set { name := 'x' }"]) {
    assertEquals(await compile(edgeql, { userId: USER_ID }), await compile(edgeql, undefined));
  }
  for (const edgeql of ["insert Owned { title := 't' }", "update Owned set { title := 'x' }"]) {
    assertEquals((await compile(edgeql, { bypass: true, userId: USER_ID })).includes("disc_access_check"), false);
  }
});
