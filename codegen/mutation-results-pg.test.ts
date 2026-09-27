/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: what the generated client's mutations and the typed
 * builder's link-without-shape selections return, which the declared result
 * types (`mutation-results.test.ts`, `sdk/schema-types.test.ts`) must match.
 *
 * - `insert` / `update` return the stored row: `id`, every stored property (an
 *   optional one `null` when unset, a multi one an array, `[]` when empty) and
 *   each single link as its target's id (`null` when an optional one is
 *   unset). Multi links, link properties and computed fields are absent.
 * - The server answers each bare mutation with the set of rows it wrote (as
 *   Gel does); the clients derive their results from it, unchanged:
 * - `update` of a missing id returns `{ updated: 0 }` (Go `nil`, Rust `None`).
 * - `delete` returns `{ deleted: n }`.
 * - The typed builder's `select({ link: true })` returns a single link's
 *   target id (`null` when an optional one is unset) and a multi link's ids
 *   (`[]` when it is empty, as in Gel); its default select (no shape)
 *   returns `id` and the stored properties, no links.
 *
 * The generated Go and Rust clients decode the same rows into their
 * `MrPostMutationResult` structs (a single link a string), and a delete's
 * count into `DeleteResult`.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL — and, for the
 * Go and Rust steps, `go` or `cargo`; without them those steps are skipped.
 */

import { assert, assertEquals } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { DiscClient } from "../sdk/client.ts";
import { createQueryBuilder } from "../sdk/query-builder.ts";
import { defineSchema, t } from "../sdk/schema-types.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import { HttpServer } from "../server/http.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { emitGo } from "./emit-go.ts";
import { emitRust } from "./emit-rust.ts";
import { emitTypeScript } from "./emit-typescript.ts";
import { schemaToIR } from "./schema-to-ir.ts";
import type { CodegenConfig, GeneratedFile } from "./types.ts";

const SDK_URL = new URL("../sdk/mod.ts", import.meta.url).href;

const SDL = `module default {
  type MrUser {
    required name: str;
    posts_by := .<author[is MrPost];
  };
  type MrTag {
    required label: str;
  };
  type MrPost {
    required title: str;
    subtitle: str;
    multi marks: int64;
    required author: MrUser;
    editor: MrUser;
    multi tags: MrTag {
      weight: int64;
    };
    tag_count := count(.tags);
  };
};`;

type Row = Record<string, unknown>;

interface PostBuilder {
  delete(id: string): Promise<Row>;
  insert(data: Row): Promise<Row>;
  update(id: string, data: Row): Promise<Row>;
}

interface GeneratedClient {
  mrpost: PostBuilder;
}

/** Generate the typed client into a temp directory and import it, with its SDK import pointed at this repo's `sdk/`. */
async function withGeneratedClient(schema: Schema, baseUrl: string, fn: (client: GeneratedClient) => Promise<void>): Promise<void> {
  const outputDir = await Deno.makeTempDir({ prefix: "disc-mutation-results-client-" });

  try {
    const files = emitTypeScript(schemaToIR(schema), {
      formatOutput: false,
      includeClient: true,
      includeMutations: true,
      includeQueryBuilders: true,
      outputDir,
      schemaSource: "mutation-results-pg.test.ts",
      sdkImportBase: SDK_URL,
      target: "client"
    });

    for (const file of files)
      await Deno.writeTextFile(file.path, file.content);

    const generated = await import(new URL(`file://${outputDir}/client.ts`).href) as {
      DiscClient: new(config: { baseUrl: string; }) => GeneratedClient;
    };

    await fn(new generated.DiscClient({ baseUrl }));
  } finally {
    await Deno.remove(outputDir, { recursive: true });
  }
}

const NATIVE_CONFIG: CodegenConfig = {
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

/*** What the Go and Rust programs print: an insert's single links as ids, an update's too, a missing id's update as nil/None, a delete's count. ***/
const EXPECTED = (title: string): string => [`inserted ${title} true true`, "updated true", "missing true", "deleted 1"].join("\n");

const GO_MAIN = `package main

import (
	"fmt"
	"os"

	"discclient"
)

func main() {
	client := discclient.NewDiscClient(os.Args[1])
	users := discclient.NewMrUserQueryBuilder(client)
	posts := discclient.NewMrPostQueryBuilder(client)
	ann, err := users.Insert(discclient.MrUserInsert{Name: "ann-go"})
	if err != nil {
		panic(err)
	}
	post, err := posts.Insert(discclient.MrPostInsert{Title: "go", Author: ann.Id})
	if err != nil {
		panic(err)
	}
	fmt.Println("inserted", post.Title, post.Author == ann.Id, post.Editor == nil)
	updated, err := posts.Update(post.Id, discclient.MrPostUpdate{Editor: &ann.Id})
	if err != nil {
		panic(err)
	}
	fmt.Println("updated", updated != nil && updated.Editor != nil && *updated.Editor == ann.Id)
	title := "x"
	missing, err := posts.Update("00000000-0000-0000-0000-000000000000", discclient.MrPostUpdate{Title: &title})
	if err != nil {
		panic(err)
	}
	fmt.Println("missing", missing == nil)
	deleted, err := posts.Delete(post.Id)
	if err != nil {
		panic(err)
	}
	fmt.Println("deleted", deleted.Deleted)
}
`;

const RUST_EXAMPLE = `use disc_client::disc_runtime::DiscClient;
use disc_client::{MrPostInsert, MrPostQueryBuilder, MrPostUpdate, MrUserInsert, MrUserQueryBuilder};

fn main() {
    let port: u16 = std::env::args().nth(1).unwrap().parse().unwrap();
    let client = DiscClient::new("127.0.0.1", port);
    let users = MrUserQueryBuilder::new(&client);
    let posts = MrPostQueryBuilder::new(&client);
    let ann = users.insert(MrUserInsert { name: "ann-rust".to_string() }).unwrap();
    let post = posts
        .insert(MrPostInsert { title: "rust".to_string(), author: ann.id.clone(), ..Default::default() })
        .unwrap();
    println!("inserted {} {} {}", post.title, post.author == ann.id, post.editor.is_none());
    let updated = posts
        .update(&post.id, MrPostUpdate { editor: Some(ann.id.clone()), ..Default::default() })
        .unwrap()
        .unwrap();
    println!("updated {}", updated.editor.as_deref() == Some(ann.id.as_str()));
    let missing = posts
        .update("00000000-0000-0000-0000-000000000000", MrPostUpdate { title: Some("x".to_string()), ..Default::default() })
        .unwrap();
    println!("missing {}", missing.is_none());
    let deleted = posts.delete(&post.id).unwrap();
    println!("deleted {}", deleted.deleted);
}
`;

async function toolAvailable(tool: string, args: string[]): Promise<boolean> {
  try {
    return (await new Deno.Command(tool, { args, stderr: "null", stdout: "null" }).output()).success;
  } catch {
    return false;
  }
}

async function run(tool: string, args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command(tool, { args, cwd, stderr: "piped", stdout: "piped" }).output();
  const decoder = new TextDecoder();
  assert(out.success, `${tool} ${args.join(" ")} failed:\n${decoder.decode(out.stderr)}`);
  return decoder.decode(out.stdout).trim();
}

/*** Write a generated client plus one program (`main`, at `mainPath`) into a temp directory for `body`. ***/
async function withProject(files: GeneratedFile[], mainPath: string, main: string, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "disc_mutation_results_" });
  try {
    for (const file of [...files, { content: main, path: mainPath }]) {
      const full = `${dir}/${file.path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(full, file.content);
    }
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const typedSchema = defineSchema({
  MrPost: {
    author: t.single("MrUser"),
    editor: t.optional(t.single("MrUser")),
    subtitle: t.optional(t.str()),
    tags: t.multi("MrTag"),
    title: t.str()
  },
  MrTag: { label: t.str() },
  MrUser: { name: t.str() }
});

Deno.test({
  name: "PG mutation results carry single links as ids; link-without-shape selections return ids",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 4, minConnections: 1 });
    await pool.initialize();
    await resetTestDatabase(pool);

    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);

    const server = new HttpServer({
      config: { databaseUrl: dsn, enableCors: false, enableWebsockets: false, host: "127.0.0.1", maxConnections: 4, port: 0, requestTimeout: 30000 },
      protocolHandler: new EdgeQLProtocolHandler({ connectionPool: pool, schema })
    });
    const listener = Deno.serve(
      { hostname: "127.0.0.1", onListen() {}, port: 0 },
      (request: Request, info: Deno.ServeHandlerInfo) =>
        // deno-lint-ignore no-explicit-any
        (server as any).handleRequest(request, info)
    );
    const baseUrl = `http://127.0.0.1:${listener.addr.port}`;
    const client = new DiscClient({ baseUrl });

    try {
      const [ann] = await client.query<{ id: string; }[]>(`insert MrUser { name := "ann" }`);
      const [bob] = await client.query<{ id: string; }[]>(`insert MrUser { name := "bob" }`);
      const [tag] = await client.query<{ id: string; }[]>(`insert MrTag { label := "t1" }`);

      await t.step("generated client: insert, update and delete results", async () => {
        await withGeneratedClient(schema, baseUrl, async generated => {
          const bare = await generated.mrpost.insert({ author: ann.id, tags: [tag.id], title: "p1" });
          assertEquals(bare, { author: ann.id, editor: null, id: bare.id, marks: [], subtitle: null, title: "p1" });

          const full = await generated.mrpost.insert({ author: ann.id, editor: bob.id, marks: [1n, 2n], subtitle: "s", title: "p2" });
          assertEquals(full, { author: ann.id, editor: bob.id, id: full.id, marks: [1n, 2n], subtitle: "s", title: "p2" });

          const updated = await generated.mrpost.update(bare.id as string, { editor: bob.id, tags: { add: [tag.id] }, title: "p1b" });
          assertEquals(updated, { author: ann.id, editor: bob.id, id: bare.id, marks: [], subtitle: null, title: "p1b" });

          // Only a multi link changes: still the stored row, without it.
          const linkOnly = await generated.mrpost.update(bare.id as string, { tags: { remove: [tag.id] } });
          assertEquals(linkOnly, updated);

          assertEquals(await generated.mrpost.update("00000000-0000-0000-0000-000000000000", { title: "x" }), { updated: 0 });

          assertEquals(await generated.mrpost.delete(full.id as string), { deleted: 1 });
          assertEquals(await generated.mrpost.delete(full.id as string), { deleted: 0 });
        });
      });

      await t.step("typed builder: a link without a shape is its id; the default select has no links", async () => {
        const qb = createQueryBuilder(client, typedSchema);

        const [row] = await qb.MrPost.select({ author: true, editor: true, tags: true, title: true }).filter(ref => ref.title.eq("p1b"));
        const author: string = row.author;
        const editor: string | null = row.editor;
        const tags: string[] = row.tags;
        assertEquals({ author, editor, tags }, { author: ann.id, editor: bob.id, tags: [] });

        await client.query(`update MrPost filter .title = "p1b" set { tags += (select MrTag), editor := {} }`);
        const [linked] = await qb.MrPost.select({ editor: true, tags: true }).filter(ref => ref.title.eq("p1b"));
        assertEquals(linked, { editor: null, tags: [tag.id] });

        const [plain] = await qb.MrPost.filter(ref => ref.title.eq("p1b"));
        const id: string = plain.id;
        const subtitle: string | null = plain.subtitle;
        // `marks` is not declared in the typed schema, but arrives all the same.
        assertEquals(plain as Row, { id, marks: [], subtitle, title: "p1b" });
      });

      await t.step({
        name: "generated Go client: Insert and Update decode the row, Delete its count",
        ignore: !(await toolAvailable("go", ["version"])),
        fn: async () => {
          await withProject(emitGo(schemaToIR(schema), NATIVE_CONFIG), "cmd/mutations/main.go", GO_MAIN, async dir => {
            assertEquals(await run("go", ["run", "./cmd/mutations", baseUrl], dir), EXPECTED("go"));
          });
        }
      });

      await t.step({
        name: "generated Rust client: insert and update decode the row, delete its count",
        ignore: !(await toolAvailable("cargo", ["--version"])),
        fn: async () => {
          await withProject(emitRust(schemaToIR(schema), NATIVE_CONFIG), "examples/mutations.rs", RUST_EXAMPLE, async dir => {
            assertEquals(
              await run("cargo", ["run", "--offline", "--quiet", "--example", "mutations", "--", String(listener.addr.port)], dir),
              EXPECTED("rust")
            );
          });
        }
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});
