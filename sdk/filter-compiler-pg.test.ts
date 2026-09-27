/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: the rows a generated client's `filter()` returns for
 * filters over multi properties, multi links and single links, combined with
 * `and`, `or` and `not`. The filter's type info comes from the TypeScript
 * codegen, and the filter compiles with `compileFilter`, as a generated
 * `filter()` does.
 *
 * What each filter means (unit tests: `sdk/filter-compiler.test.ts`):
 *
 * - A condition on a multi property or through a multi link holds when some
 *   element satisfies it, and is false when there is none.
 * - Sibling keys and `and` are independent conditions: over a multi link they
 *   need not hold for the same linked object.
 * - `not` negates a condition: `not({ nicks: "a1" })` is "no nick is a1".
 * - `or` holds when either condition does.
 *
 * Seed: users ann (visits 3, nicks {a1, a2}, best Hello, posts {Hello,
 * World}) and bob (nothing optional set); post Hello has tags {t1}, World
 * {t1, t2}.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import { emitTypeScript, schemaToIR } from "../codegen/mod.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import type * as ServerTypes from "../server/types.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { compileFilter, type TypeInfo } from "./filter-compiler.ts";
import { and, not, or, type FilterArg } from "./query-builder.ts";

const SDL = `module default {
  type FltTag {
    required name: str;
  };
  type FltPost {
    required title: str;
    multi tags: FltTag;
  };
  type FltUser {
    required name: str;
    visits: int64;
    multi nicks: str;
    best: FltPost;
    multi posts: FltPost;
  };
};`;

const SDK_URL = new URL("./mod.ts", import.meta.url).href;

type Run = (query: string, variables?: Record<string, unknown>) => Promise<unknown[]>;

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `filter_compiler_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

/*** The `_typeInfo` of the generated `FltUser` query builder. ***/
async function generatedUserTypeInfo(schema: Parameters<typeof schemaToIR>[0]): Promise<TypeInfo> {
  const outputDir = await Deno.makeTempDir({ prefix: "disc-filter-compiler-client-" });
  try {
    const files = emitTypeScript(schemaToIR(schema), {
      formatOutput: false,
      includeClient: true,
      includeMutations: true,
      includeQueryBuilders: true,
      outputDir,
      schemaSource: "./dbschema/default.disc",
      sdkImportBase: SDK_URL,
      target: "client"
    });
    for (const file of files) {
      await Deno.writeTextFile(file.path, file.content);
    }
    const queries = await import(new URL(`file://${outputDir}/queries.ts`).href) as { FltUserQueryBuilder: { _typeInfo: TypeInfo; }; };
    return queries.FltUserQueryBuilder._typeInfo;
  } finally {
    await Deno.remove(outputDir, { recursive: true });
  }
}

/*** Run `fn` against the seeded schema with a `filter()` that returns each matching user's shape, ordered by name. ***/
async function withUsers(fn: (filter: (arg: FilterArg) => Promise<unknown[]>) => Promise<void>): Promise<void> {
  const dsn = await getTestDsn();
  const pool: ConnectionPool = makePool(dsn);
  await pool.initialize();

  try {
    await resetTestDatabase(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
    const schema = manager.getSchema()!;
    const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema });
    await manager.close();
    const typeInfo = await generatedUserTypeInfo(schema);

    const run: Run = async (query, variables) => {
      const response = await handler.handleRequest({ query, variables }, makeContext());
      assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
      return response.data as unknown[];
    };

    await run("insert FltTag { name := 't1' }");
    await run("insert FltTag { name := 't2' }");
    await run("insert FltPost { title := 'Hello', tags := (select FltTag filter .name = 't1') }");
    await run("insert FltPost { title := 'World', tags := (select FltTag) }");
    await run(
      "insert FltUser { name := 'ann', visits := 3, nicks := {'a1', 'a2'}, " +
        "best := (select FltPost filter .title = 'Hello' limit 1), posts := (select FltPost) }"
    );
    await run("insert FltUser { name := 'bob' }");

    await fn(async arg => {
      const compiled = compileFilter("FltUser", arg, typeInfo);
      const query = [`select FltUser ${compiled.selectShape ?? "{ name }"}`];
      if (compiled.clause) {
        query.push(`filter ${compiled.clause}`);
      }
      query.push("order by .name");
      return await run(query.join(" "), compiled.variables);
    });
  } finally {
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG SDK filter: multi property, multi link and single link conditions under and / or / not",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withUsers(async filter => {
      const names = async (arg: FilterArg): Promise<string[]> => ((await filter(arg)) as { name: string; }[]).map(user => user.name);
      const cases: [string, FilterArg, string[]][] = [
        // A multi property: some element satisfies the condition.
        ["nick a1", { nicks: "a1" }, ["ann"]],
        ["no nick a1", not({ nicks: "a1" }), ["bob"]],
        ["no nick zz", not({ nicks: "zz" }), ["ann", "bob"]],
        ["a nick other than a1", { nicks: { ne: "a1" } }, ["ann"]],
        ["no nick other than a1", not({ nicks: { ne: "a1" } }), ["bob"]],
        ["a nick in [a1, zz]", { nicks: { in: ["a1", "zz"] } }, ["ann"]],
        ["no nick in [a1, zz]", not({ nicks: { in: ["a1", "zz"] } }), ["bob"]],
        ["a nick not in [a1]", { nicks: { not_in: ["a1"] } }, ["ann"]],
        ["no nick not in [a1, a2]", not({ nicks: { not_in: ["a1", "a2"] } }), ["ann", "bob"]],
        ["a nick like a%", { nicks: { like: "a%" } }, ["ann"]],
        ["no nick like a%", not({ nicks: { like: "a%" } }), ["bob"]],
        ["nick a1 and nick a2 (independent)", and({ nicks: "a1" }, { nicks: "a2" }), ["ann"]],
        ["nick a1 or name bob", or({ nicks: "a1" }, { name: "bob" }), ["ann", "bob"]],
        ["nick zz or name bob", or({ nicks: "zz" }, { name: "bob" }), ["bob"]],
        ["neither nick a1 nor name ann", not(or({ nicks: "a1" }, { name: "ann" })), ["bob"]],
        // Through a multi link, one and two hops.
        ["a post Hello", { posts: { title: "Hello" } }, ["ann"]],
        ["no post Hello", not({ posts: { title: "Hello" } }), ["bob"]],
        ["a post not Hello", { posts: { title: { ne: "Hello" } } }, ["ann"]],
        ["a post Nope or name bob", or({ posts: { title: "Nope" } }, { name: "bob" }), ["bob"]],
        ["a post tagged t2", { posts: { tags: { name: "t2" } } }, ["ann"]],
        ["no post tagged t2", not({ posts: { tags: { name: "t2" } } }), ["bob"]],
        ["a post without tag t2", { posts: { tags: { name: { ne: "t2" } } } }, ["ann"]],
        ["a post Hello and a post tagged t2 (not necessarily the same)", { posts: { tags: { name: "t2" }, title: "Hello" } }, ["ann"]],
        ["a post Hello and no post tagged t2", { posts: and({ title: "Hello" }, not({ tags: { name: "t2" } })) }, []],
        ["nick a1 and a post World", { nicks: "a1", posts: { title: "World" } }, ["ann"]],
        // Single properties and a single link: an empty value compares as SQL NULL.
        ["visits 3", { visits: 3 }, ["ann"]],
        ["not visits 3", not({ visits: 3 }), []],
        ["best Hello", { best: { title: "Hello" } }, ["ann"]],
        ["not best Hello", not({ best: { title: "Hello" } }), []],
        ["best Nope or name bob", or({ best: { title: "Nope" } }, { name: "bob" }), ["bob"]],
        ["best Hello and a post tagged t2", { best: { title: "Hello" }, posts: { tags: { name: "t2" } } }, ["ann"]]
      ];
      for (const [description, arg, expected] of cases) {
        assertEquals(await names(arg), expected, description);
      }

      // A link's `filter` in `select` narrows that link's set, per linked object.
      assertEquals(
        await filter({ select: { name: true, posts: { filter: not({ tags: { name: "t2" } }), title: true } } }),
        [{ name: "ann", posts: [{ title: "Hello" }] }, { name: "bob", posts: [] }]
      );
    });
  }
});
