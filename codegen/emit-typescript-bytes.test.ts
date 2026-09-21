/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `bytes` through the generated TypeScript client. The generated types say
 * `Uint8Array`; the wire says base64. These tests run the emitted builders
 * (imported from a temp directory, SDK at HEAD) against a stubbed `fetch`:
 * what they send is base64, what they return is a `Uint8Array`, also through a
 * link, whether the link arrives as a one-element array or as an object.
 */

import { assert, assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { emitTypeScript, schemaToIR } from "./mod.ts";

const SDK_URL = new URL("../sdk/mod.ts", import.meta.url).href;

const SDL = `
module default {
  type Blob {
    chunks: array<bytes>;
    content: bytes;
    required name: str;
    link parent -> Blob;
  }
}`;

interface BlobRow {
  chunks?: Uint8Array[];
  content?: Uint8Array | null;
  name?: string;
  parent?: BlobRow | BlobRow[];
}

interface BlobBuilder {
  filter(filter: Record<string, unknown>): Promise<BlobRow[]>;
  insert(data: Record<string, unknown>): Promise<BlobRow>;
  select(shape?: string): Promise<BlobRow[]>;
  selectById(id: string, shape?: string): Promise<BlobRow | null>;
  update(id: string, data: Record<string, unknown>): Promise<BlobRow>;
}

/*** Runs `fn` with the generated client; every request is answered with `{ data }` and its parsed body is pushed to `requests`. ***/
async function withGeneratedClient(
  data: unknown,
  fn: (blob: BlobBuilder, requests: Array<{ query: string; variables?: Record<string, unknown>; }>) => Promise<void>
): Promise<void> {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  const parsed = manager.parseSDL(SDL);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }

  const outputDir = await Deno.makeTempDir({ prefix: "disc-emit-bytes-" });
  const requests: Array<{ query: string; variables?: Record<string, unknown>; }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(init?.body as string));
    return Promise.resolve(new Response(JSON.stringify({ data })));
  };

  try {
    const files = emitTypeScript(schemaToIR(manager.modulesToSchema(parsed.value)), {
      formatOutput: false,
      includeClient: true,
      includeMutations: true,
      includeQueryBuilders: true,
      outputDir,
      schemaSource: "bytes.disc",
      sdkImportBase: SDK_URL,
      target: "client"
    });
    for (const file of files) {
      await Deno.writeTextFile(file.path, file.content);
    }
    const generated = await import(new URL(`file://${outputDir}/client.ts`).href) as {
      DiscClient: new(config: { baseUrl: string; }) => { blob: BlobBuilder; };
    };
    await fn(new generated.DiscClient({ baseUrl: "http://disc.invalid" }).blob, requests);
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(outputDir, { recursive: true });
  }
}

Deno.test("generated builder - insert sends a Uint8Array as base64 and returns one", async () => {
  await withGeneratedClient({ chunks: ["AQ=="], content: "H4sA/w==", name: "a" }, async (blob, requests) => {
    const row = await blob.insert({ chunks: [new Uint8Array([1])], content: new Uint8Array([0x1f, 0x8b, 0x00, 0xff]), name: "a" });

    assertEquals(requests[0].variables, { chunks: ["AQ=="], content: "H4sA/w==", name: "a" });
    assertEquals(row.content, new Uint8Array([0x1f, 0x8b, 0x00, 0xff]));
    assertEquals(row.chunks, [new Uint8Array([1])]);
    assertEquals(row.name, "a");
  });
});

Deno.test("generated builder - filter, select and selectById return Uint8Array", async () => {
  await withGeneratedClient([{ content: "AQID", name: "AQID" }], async blob => {
    for (const rows of [await blob.filter({ name: "AQID" }), await blob.select()]) {
      assertEquals(rows, [{ content: new Uint8Array([1, 2, 3]), name: "AQID" }]);
    }
    assertEquals(await blob.selectById("00000000-0000-0000-0000-000000000001"), { content: new Uint8Array([1, 2, 3]), name: "AQID" });
  });
});

Deno.test("generated builder - update returns Uint8Array; null stays null", async () => {
  await withGeneratedClient({ content: null, name: "a" }, async blob => {
    assertEquals(await blob.update("00000000-0000-0000-0000-000000000001", { content: null }), { content: null, name: "a" });
  });
});

Deno.test("generated builder - bytes inside a link are revived, as a one-element array or an object", async () => {
  await withGeneratedClient([{ parent: [{ content: "AQ==" }] }, { parent: { content: "Ag==" } }], async blob => {
    const rows = await blob.select("{ parent: { content } }");
    const wrapped = rows[0].parent as BlobRow[];
    const plain = rows[1].parent as BlobRow;

    assert(Array.isArray(wrapped));
    assertEquals(wrapped[0].content, new Uint8Array([1]));
    assertEquals(plain.content, new Uint8Array([2]));
  });
});
