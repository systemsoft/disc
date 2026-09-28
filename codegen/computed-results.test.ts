/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Schema computeds are typed by what their expression yields, as Gel infers
 * it (Gel 7.1's introspection for the same schema): not only a path
 * (`auth := .author`, `bodies := .<post[is C].body`) but an aggregate, an
 * operator or a call (`n_posts := count(…)` is a required `int64`, `full :=
 * .nick ++ ' ' ++ .name` an optional `str` when `nick` is optional), a
 * declared `single` making a computed one value, and `unknown` only for an
 * expression whose type can't be told. Observed end to end in
 * `computed-results-pg.test.ts`.
 *
 * A link's `select` also takes `limit` / `offset` (`filter-api.md`).
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import type { Schema } from "../compiler/context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { cleanupTempDir, createTempDir } from "../tests/test-utils.ts";
import type { CodegenConfig } from "./types.ts";

/*** RUNTIME ------------------------------------------ ***/

import { emitGo } from "./emit-go.ts";
import { emitRust } from "./emit-rust.ts";
import { emitTypeScript } from "./emit-typescript.ts";
import { generateTypeScript, writeGeneratedFiles } from "./mod.ts";
import { schemaToIR } from "./schema-to-ir.ts";

const SDL = `
module default {
  function shout(s: str) -> str using (str_upper(s) ++ '!');
  function parts(s: str) -> set of str using (str_split(s, ',')[0]);
  function maybe(s: str) -> optional str using (s if len(s) > 2 else <str>{});
  function pair(s: str) -> array<str> using ([s, s]);
  type Person {
    required name: str;
    nick: str;
    age: int64;
    multi tags: str;
    n_posts := count(.<author[is Post]);
    full := .nick ++ ' ' ++ .name;
    greeting := 'hi ' ++ .name;
    is_old := .age > 60;
    tags_up := array_agg(str_upper(.tags));
    up := str_upper(.tags);
    last_seen := max(.<author[is Post].created);
    counts := (posts := count(.<author[is Post]), tags := count(.tags));
    single first_post := (select .<author[is Post] order by .title limit 1);
    single latest := assert_single((select .<author[is Post] order by .created desc limit 1));
    loud := shout(.name);
    nick_loud := shout(.nick);
    name_parts := parts(.name);
    maybe_name := maybe(.name);
    name_pair := pair(.name);
    names := .name union .nick;
    n_half := len(.name) // 2;
    age_sq := .age ^ 2;
    not_ann := .name not like 'Ann%';
  }
  type Post {
    required title: str;
    required author: Person;
    created: datetime;
  }
}
`;

function schema(sdl = SDL): Schema {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(sdl, { validate: true });
  if (!parsed.ok)
    throw parsed.error;
  return mgr.modulesToSchema(parsed.value);
}

function config(): CodegenConfig {
  return {
    formatOutput: true,
    includeClient: true,
    includeMutations: true,
    includeQueryBuilders: true,
    interfaceSuffix: "",
    outputDir: ".",
    schemaSource: "./dbschema/default.disc",
    target: "client",
    typePrefix: ""
  };
}

function content(files: { content: string; path: string; }[], suffix: string): string {
  const file = files.find(f => f.path.endsWith(suffix));
  assert(file, `expected a generated ${suffix}`);
  return file.content;
}

Deno.test("computed results - a non-path computed is typed by its expression, with Gel's cardinality", () => {
  const person = schema().types.get("Person")!;
  const typeOf = (name: string) => {
    const property = person.properties.get(name)!;
    return `${property.required ? "required" : "optional"} ${property.multi ? "multi" : "single"} ${property.edgeqlType}`;
  };
  // Gel 7.1: `select schema::ObjectType { pointers: { name, cardinality, required, target } }`.
  assertEquals(typeOf("n_posts"), "required single int64");
  assertEquals(typeOf("full"), "optional single str");
  assertEquals(typeOf("greeting"), "required single str");
  assertEquals(typeOf("is_old"), "optional single bool");
  assertEquals(typeOf("tags_up"), "required single array<str>");
  assertEquals(typeOf("up"), "optional multi str");
  assertEquals(typeOf("last_seen"), "optional single datetime");
  assertEquals(typeOf("counts"), "required single tuple<posts: int64, tags: int64>");
  // A function the schema declares is of its declared return type.
  assertEquals(typeOf("loud"), "required single str");
  assertEquals(typeOf("nick_loud"), "optional single str");
  assertEquals(typeOf("name_parts"), "optional multi str");
  assertEquals(typeOf("maybe_name"), "optional single str");
  assertEquals(typeOf("name_pair"), "required single array<str>");
  // Any EdgeQL expression: set operators, `//`.
  assertEquals(typeOf("names"), "required multi str");
  assertEquals(typeOf("n_half"), "required single int64");
  // `^` is a power: an int64 raised is a float64.
  assertEquals(typeOf("age_sq"), "optional single float64");
  assertEquals(typeOf("not_ann"), "required single bool");
});

Deno.test("computed results - TypeScript declares each computed's type and cardinality", () => {
  const types = content(emitTypeScript(schemaToIR(schema()), config()), "interfaces.ts");

  assertStringIncludes(types, " n_posts: bigint;\n");
  assertStringIncludes(types, " full?: string | null;\n");
  assertStringIncludes(types, " greeting: string;\n");
  assertStringIncludes(types, " is_old?: boolean | null;\n");
  assertStringIncludes(types, " tags_up: string[];\n");
  assertStringIncludes(types, " up?: string[] | null;\n");
  assertStringIncludes(types, " last_seen?: Date | null;\n");
  assertStringIncludes(types, " counts: { posts: bigint; tags: bigint };\n");
  assertStringIncludes(types, " first_post?: [Post] | null;\n");
  assertStringIncludes(types, " latest?: [Post] | null;\n");
  assertStringIncludes(types, " loud: string;\n");
  assertStringIncludes(types, " name_parts?: string[] | null;\n");
  assertStringIncludes(types, " name_pair: string[];\n");
});

Deno.test("computed results - the query builders revive a typed computed as a stored property", () => {
  const queries = content(emitTypeScript(schemaToIR(schema()), config()), "queries.ts");

  assertStringIncludes(queries, `n_posts: "<int64>"`);
  assertStringIncludes(queries, `last_seen: "<datetime>"`);
  assertStringIncludes(queries, `multi: ["tags", "up", "name_parts", "names"]`);
});

Deno.test("computed results - Rust and Go declare each computed's type", () => {
  const ir = schemaToIR(schema());
  const lib = emitRust(ir, config()).map(f => f.content).join("\n");
  assertStringIncludes(lib, "pub n_posts: i64,");
  assertStringIncludes(lib, "pub full: Option<String>,");
  assertStringIncludes(lib, "pub is_old: Option<bool>,");
  assertStringIncludes(lib, "pub tags_up: Vec<String>,");
  assertStringIncludes(lib, "pub up: Vec<String>,");

  const models = emitGo(ir, config()).map(f => f.content).join("\n");
  assertStringIncludes(models, "\tNPosts int64 `json:\"n_posts\"`");
  assertStringIncludes(models, "\tFull *string `json:\"full,omitempty\"`");
  assertStringIncludes(models, "\tTagsUp []string `json:\"tags_up\"`");
});

Deno.test("computed results - `single` on a computed that may yield several is a schema error, as in Gel", () => {
  const mgr = new SchemaManager({ dryRun: true });
  const check = (pointer: string) =>
    mgr.parseSDL(
      `module default {
        type C { required body: str; created: int64; required post: P; }
        type P { required title: str; multi tags: str; ${pointer} }
      }`,
      { validate: true }
    );
  // Gel 7.1: "possibly more than one element returned by an expression for
  // the computed pointer 'first' of object type 'default::P' explicitly
  // declared as 'single'".
  for (
    const [pointer, kind] of [
      ["single first := (select .<post[is C] order by .created);", "link 'first'"],
      ["single link first := .<post[is C];", "link 'first'"],
      ["single first := (select C filter .body = 'x');", "link 'first'"],
      ["single first := .tags;", "property 'first'"],
      ["single first := str_upper(.tags);", "property 'first'"],
      ["single first := {1, 2};", "property 'first'"]
    ]
  ) {
    const result = check(pointer);
    assert(!result.ok, `${pointer} must be rejected`);
    assertStringIncludes(
      result.error.message,
      `possibly more than one element returned by an expression for the computed ${kind} of object type 'P' explicitly declared as 'single'`
    );
  }
  for (
    const pointer of [
      "single first := (select .<post[is C] order by .created limit 1);",
      "single first := (select C filter .id = <uuid>'00000000-0000-0000-0000-000000000000');",
      "single first := assert_single(.<post[is C]);",
      "single first := count(.<post[is C]);",
      "single first := array_agg(.tags);",
      "single first := .title ++ '!';"
    ]
  ) {
    const result = check(pointer);
    assert(result.ok, `${pointer}: ${result.ok ? "" : result.error.message}`);
  }
});

Deno.test("computed results - the generated client types a computed by its expression, and a link's select takes limit / offset", async () => {
  const tempDir = await createTempDir();

  try {
    const result = generateTypeScript(schema(), { outputDir: "disc-client" });
    await writeGeneratedFiles(result, tempDir, { runFmt: false });

    const sdkDir = new URL("../sdk/", import.meta.url);
    const targetDir = join(tempDir, "disc-client", "sdk");
    await Deno.mkdir(targetDir, { recursive: true });
    for await (const entry of Deno.readDir(sdkDir)) {
      if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
        await Deno.copyFile(new URL(entry.name, sdkDir), join(targetDir, entry.name));
    }

    await Deno.writeTextFile(
      join(tempDir, "consumer.ts"),
      `import type { $default } from "./disc-client/index.ts";

type Person = $default.Person;

export function read(person: Person): unknown[] {
  // @ts-expect-error count() is an int64: a bigint
  const bad: number = person.n_posts;
  // @ts-expect-error an optional operand makes the concatenation optional
  const badFull: string = person.full;
  // @ts-expect-error a comparison is a boolean
  const badOld: string | null | undefined = person.is_old;
  const posts: bigint = person.n_posts;
  const full: string | null | undefined = person.full;
  const greeting: string = person.greeting;
  const tags: string[] = person.tags_up;
  const up: string[] | null | undefined = person.up;
  const seen: Date | null | undefined = person.last_seen;
  const counted: bigint = person.counts.posts;
  const first: string | undefined = person.first_post?.[0].title;
  return [bad, badFull, badOld, posts, full, greeting, tags, up, seen, counted, first];
}

export const capped: $default.PersonFilter = {
  select: { first_post: { limit: 1, offset: 0, order_by: "-title", title: true }, name: true }
};
// @ts-expect-error a link's limit is a number
export const badLimit: $default.PersonFilter = { select: { first_post: { limit: "1" } } };
`
    );

    const out = await new Deno.Command(Deno.execPath(), { args: ["check", "--no-config", "consumer.ts"], cwd: tempDir, stderr: "piped", stdout: "piped" })
      .output();
    const output = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    assert(out.success, `consumer should type-check against the generated client; output:\n${output}`);
  } finally {
    await cleanupTempDir(tempDir);
  }
});
