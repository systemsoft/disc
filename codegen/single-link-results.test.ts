/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A single link selected with a sub-shape arrives as a one-element array of
 * rows (`author: [{ name }]`), or `null` when an optional one is empty -- a
 * documented divergence from Gel, which returns the object itself (pinned in
 * `tests/gel-divergence-pins.test.ts`, observed end to end in
 * `single-link-results-pg.test.ts`). The result types every emitter declares
 * must say so, or `row.author.name` type-checks and reads `undefined`:
 *
 * - TypeScript: `author: [User]`, `editor?: [User] | null`;
 * - Rust: `Vec<User>`, `Option<Vec<User>>`;
 * - Go: `[]User`.
 *
 * Insert/Update data still takes a single link as the target's UUID.
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
    manager: User;
  }
  type Tag {
    required label: str;
    owner: User;
  }
  type Post {
    required title: str;
    required author: User;
    editor: User;
    multi tags: Tag;
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

Deno.test("single link results - TypeScript declares a one-element array, null when optional", () => {
  const types = content(emitTypeScript(schemaToIR(schema()), config()), "interfaces.ts");

  assertStringIncludes(types, " author: [User];\n");
  assertStringIncludes(types, " editor?: [User] | null;\n");
  assertStringIncludes(types, " manager?: [User] | null;\n");
  assertStringIncludes(types, " owner?: [User] | null;\n");
  // Multi links and write data are unchanged.
  assertStringIncludes(types, " tags?: Tag[] | null;\n");
  assertMatch(types, /export interface PostInsert \{[^}]*\n\s+author: string;\n/);
  assertMatch(types, /export interface PostUpdate \{[^}]*\n\s+editor\?: string;\n/);
});

Deno.test("single link results - a computed link is typed like a stored one", () => {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(
    `module default {
      type User { required name: str; manager: User; }
      type Comment { required post: Post; created: datetime; }
      type Post {
        required author: User;
        auth := .author;
        boss := .author.manager;
        single first_comment := (select .<post[is Comment] order by .created limit 1);
        multi ordered := (select .<post[is Comment] order by .created);
        multi link recent := (select .<post[is Comment] order by .created desc limit 2);
        required single link writer := .author;
        property made := .<post[is Comment].created;
      }
    }`,
    { validate: false }
  );
  if (!parsed.ok)
    throw parsed.error;
  const types = content(emitTypeScript(schemaToIR(mgr.modulesToSchema(parsed.value)), config()), "interfaces.ts");

  assertStringIncludes(types, " auth: [User];\n");
  assertStringIncludes(types, " boss?: [User] | null;\n");
  assertStringIncludes(types, " first_comment?: [Comment] | null;\n");
  assertStringIncludes(types, " ordered?: Comment[] | null;\n");
  assertStringIncludes(types, " recent?: Comment[] | null;\n");
  assertStringIncludes(types, " writer: [User];\n");
  // A computed property over a backlink: the values, as a multi property is.
  assertStringIncludes(types, " made?: Date[] | null;\n");
  // Computed links are read-only.
  assertMatch(types, /export interface PostInsert \{\n\s+\/\*\*[^\n]*\n\s+author: string;\n\s+\}/);
});

Deno.test("single link results - Rust declares a Vec, optional when the link is", () => {
  const lib = emitRust(schemaToIR(schema()), config()).map(f => f.content).join("\n");

  assertStringIncludes(lib, "pub author: Vec<crate::User>,");
  assertStringIncludes(lib, "pub editor: Option<Vec<crate::User>>,");
  assertStringIncludes(lib, "pub manager: Option<Vec<crate::User>>,");
});

Deno.test("single link results - Go declares a slice", () => {
  const models = emitGo(schemaToIR(schema()), config()).map(f => f.content).join("\n");

  assertStringIncludes(models, "\tAuthor []User `json:\"author,omitempty\"`");
  assertStringIncludes(models, "\tEditor []User `json:\"editor,omitempty\"`");
  assertStringIncludes(models, "\tManager []User `json:\"manager,omitempty\"`");
});

Deno.test("single link results - the generated client reads a single link through its array, not as an object", async () => {
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

type Post = $default.Post;
type User = $default.User;

export function read(post: Post): string[] {
  // @ts-expect-error a required single link is a one-element array
  const bad: string = post.author.name;
  // @ts-expect-error an optional single link is a one-element array or null
  const badOptional: string | undefined = post.editor?.name;
  const author: User = post.author[0];
  const manager: [User] | null | undefined = author.manager;
  const owners = (post.tags ?? []).map(tag => tag.owner?.[0].name ?? "");
  return [bad, badOptional ?? "", author.name, post.editor?.[0].name ?? "", manager?.[0].name ?? "", ...owners];
}

export const insert: $default.PostInsert = { author: "00000000-0000-0000-0000-000000000000", title: "t" };
export const update: $default.PostUpdate = { editor: "00000000-0000-0000-0000-000000000000" };
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
