/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * LocalFileStorage tests — round-trip put/get/head/delete plus key-
 * sanitization rejection.
 */

import {
  assertEquals,
  assertRejects
} from "@std/assert";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { LocalFileStorage } from "./local.ts";

async function withTempDir(
  fn: (root: string) => Promise<void>
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "disc-files-test-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("LocalFileStorage — put + get round-trip", async () => {
  await withTempDir(async root => {
    const fs = new LocalFileStorage(root);
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    await fs.put("abcdef0123", body);
    const got = await fs.get("abcdef0123");
    assertEquals(got.length, body.length);
    for (let i = 0; i < body.length; i++) {
      assertEquals(got[i], body[i]);
    }
  });
});

Deno.test("LocalFileStorage — uses 2-level fanout for keys ≥4 chars", async () => {
  await withTempDir(async root => {
    const fs = new LocalFileStorage(root);
    await fs.put("abcdef", new Uint8Array([0]));
    // ab/cd/abcdef — verifies the sharding without exposing it as API
    const stat = await Deno.stat(join(root, "ab", "cd", "abcdef"));
    assertEquals(stat.isFile, true);
  });
});

Deno.test("LocalFileStorage — short keys (<4 chars) skip fanout", async () => {
  await withTempDir(async root => {
    const fs = new LocalFileStorage(root);
    await fs.put("xy", new Uint8Array([7]));
    const stat = await Deno.stat(join(root, "xy"));
    assertEquals(stat.isFile, true);
  });
});

Deno.test("LocalFileStorage — head returns size on hit, null on miss", async () => {
  await withTempDir(async root => {
    const fs = new LocalFileStorage(root);
    await fs.put("aaaa1", new Uint8Array(42));
    const head = await fs.head("aaaa1");
    assertEquals(head?.size, 42);
    assertEquals(await fs.head("missing-key"), null);
  });
});

Deno.test("LocalFileStorage — delete is idempotent on missing keys", async () => {
  await withTempDir(async root => {
    const fs = new LocalFileStorage(root);
    // Should not throw
    await fs.delete("never-existed");
  });
});

Deno.test("LocalFileStorage — atomic write hides partial state", async () => {
  await withTempDir(async root => {
    const fs = new LocalFileStorage(root);
    await fs.put("test1", new Uint8Array([1]));
    await fs.put("test1", new Uint8Array([2, 2, 2]));
    const got = await fs.get("test1");
    assertEquals(got.length, 3);
    assertEquals(got[0], 2);
  });
});

Deno.test("LocalFileStorage — rejects path-traversal keys", async () => {
  await withTempDir(async root => {
    const fs = new LocalFileStorage(root);
    await assertRejects(() => fs.put("../escape", new Uint8Array([0])), Error);
    await assertRejects(() => fs.put("a/b", new Uint8Array([0])), Error);
    await assertRejects(() => fs.put("\u0000", new Uint8Array([0])), Error);
  });
});

Deno.test("LocalFileStorage — concurrent writes to different keys don't collide", async () => {
  await withTempDir(async root => {
    const fs = new LocalFileStorage(root);
    const N = 20;
    await Promise.all(
      Array.from(
        { length: N },
        (_, i) => fs.put(`key${i.toString().padStart(4, "0")}`, new Uint8Array([i]))
      )
    );
    for (let i = 0; i < N; i++) {
      const got = await fs.get(`key${i.toString().padStart(4, "0")}`);
      assertEquals(got[0], i);
    }
  });
});
