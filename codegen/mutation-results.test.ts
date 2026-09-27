/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A generated client's `insert` and `update` return the stored row, not a
 * shape: `id`, every stored property, and each single link as its target's id
 * (`null` when an optional one is unset). Multi links and computed fields are
 * absent. An update of a missing id returns `{ updated: 0 }`, a delete
 * `{ deleted: n }` (observed end to end in `mutation-results-pg.test.ts`). The
 * declared result types must say so, or `row.author.name` type-checks and
 * reads `undefined`:
 *
 * - TypeScript: `PostMutationResult` (`author: string`, `editor: string | null`),
 *   `update` resolving to it or `{ updated: 0 }`;
 * - Rust: `PostMutationResult` (`String`, `Option<String>`), `delete` -> `DeleteResult`;
 * - Go: `PostMutationResult` (`string`, `*string`), `Delete` -> `DeleteResult`.
 *
 * Insert/Update data is unchanged.
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertMatch, assertStringIncludes } from "@std/assert";
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
  type User {
    required name: str;
  }
  type Tag {
    required label: str;
  }
  type Post {
    required title: str;
    subtitle: str;
    multi marks: int64;
    required author: User;
    editor: User;
    multi tags: Tag;
    tag_count := count(.tags);
  }
}
`;

function schema(): Schema {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SDL, { validate: false });
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

/*** The body of `interface <name> { … }` in `source`. ***/
function interfaceBody(source: string, name: string): string {
  const match = source.match(new RegExp(`export interface ${name} \\{([^}]*)\\}`));
  assert(match, `expected interface ${name}`);
  return match[1];
}

Deno.test("mutation results - TypeScript declares the stored row, single links as ids", () => {
  const files = emitTypeScript(schemaToIR(schema()), config());
  const body = interfaceBody(content(files, "interfaces.ts"), "PostMutationResult");

  assertStringIncludes(body, " id: string;\n");
  assertStringIncludes(body, " title: string;\n");
  assertStringIncludes(body, " subtitle: string | null;\n");
  assertStringIncludes(body, " marks: bigint[];\n");
  assertStringIncludes(body, " author: string;\n");
  assertStringIncludes(body, " editor: string | null;\n");
  assert(!body.includes("tags"), "a multi link is absent");
  assert(!body.includes("tag_count"), "a computed field is absent");

  const queries = content(files, "queries.ts");
  assertMatch(queries, /async insert\(data: Types\.\$default\.PostInsert\): Promise<Types\.\$default\.PostMutationResult>/);
  assertMatch(queries, /async update\(id: string, data: Types\.\$default\.PostUpdate\): Promise<Types\.\$default\.PostMutationResult \| \{ updated: 0 \}>/);
  assertStringIncludes(queries, "async delete(id: string): Promise<{ deleted: number }>");
});

Deno.test("mutation results - Rust declares the stored row and a delete count", () => {
  const lib = emitRust(schemaToIR(schema()), config()).map(f => f.content).join("\n");
  const struct = lib.match(/pub struct PostMutationResult \{([^}]*)\}/);
  assert(struct, "expected PostMutationResult");

  assertStringIncludes(struct[1], "pub author: String,");
  assertStringIncludes(struct[1], "pub editor: Option<String>,");
  assertStringIncludes(struct[1], "pub marks: Vec<i64>,");
  assert(!struct[1].includes("tags") && !struct[1].includes("tag_count"), "multi links and computed fields are absent");
  assertStringIncludes(lib, "pub fn insert(&self, data: PostInsert) -> Result<PostMutationResult, DiscError>");
  assertStringIncludes(lib, "pub fn update(&self, id: &str, data: PostUpdate) -> Result<PostMutationResult, DiscError>");
  assertStringIncludes(lib, "pub fn delete(&self, id: &str) -> Result<crate::DeleteResult, DiscError>");
  assertStringIncludes(lib, "pub struct DeleteResult {\n    pub deleted: i64,\n}");
});

Deno.test("mutation results - Go declares the stored row and a delete count", () => {
  const files = emitGo(schemaToIR(schema()), config());
  const models = content(files, "models.go");
  const struct = models.match(/type PostMutationResult struct \{([^}]*)\}/);
  assert(struct, "expected PostMutationResult");

  assertStringIncludes(struct[1], "\tAuthor string `json:\"author\"`");
  assertStringIncludes(struct[1], "\tEditor *string `json:\"editor,omitempty\"`");
  assert(!struct[1].includes("Tags") && !struct[1].includes("TagCount"), "multi links and computed fields are absent");

  const queries = content(files, "queries.go");
  assertStringIncludes(queries, ") Insert(data PostInsert) (PostMutationResult, error)");
  assertStringIncludes(queries, ") Update(id string, data PostUpdate) (PostMutationResult, error)");
  assertStringIncludes(queries, ") Delete(id string) (DeleteResult, error)");
  assertStringIncludes(queries, "type DeleteResult struct {\n\tDeleted int64 `json:\"deleted\"`\n}");
});

Deno.test("mutation results - the generated client reads a mutation's single link as an id, not an object", async () => {
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
      `import type { DiscClient } from "./disc-client/index.ts";

export async function write(client: DiscClient): Promise<string[]> {
  const post = await client.post.insert({ author: "00000000-0000-0000-0000-000000000000", title: "t" });
  // @ts-expect-error a mutation returns a single link as its target's id
  const bad: string = post.author.name;
  // @ts-expect-error a mutation returns no multi links
  const tags = post.tags;
  // @ts-expect-error a mutation returns no computed fields
  const count = post.tag_count;
  const author: string = post.author;
  const editor: string | null = post.editor;
  const marks: bigint[] = post.marks;

  const updated = await client.post.update(post.id, { title: "u" });
  // @ts-expect-error an update of a missing id returns { updated: 0 }
  const title: string = updated.title;
  const missing: 0 | undefined = "updated" in updated ? updated.updated : undefined;
  const updatedAuthor: string = "id" in updated ? updated.author : "";

  const { deleted } = await client.post.delete(post.id);
  return [bad, String(tags), String(count), author, editor ?? "", String(marks), title, String(missing), updatedAuthor, String(deleted)];
}
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
