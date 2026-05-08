/**
 * FileManager integration tests using the in-memory TestDatabase
 * and LocalFileStorage on a tmpdir.
 */

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TestDatabase } from "../../auth/test-database.ts";
import { LocalFileStorage } from "./local.ts";
import { FileAccessDeniedError, FileManager, FileNotFoundError, FileTooLargeError } from "./manager.ts";

async function setup(): Promise<{
  manager: FileManager;
  db: TestDatabase;
  root: string;
  cleanup: () => Promise<void>;
}> {
  const db = new TestDatabase();
  await db.connect();
  // Stub a users table — FileManager FK is just a referential hint; the
  // TestDatabase doesn't enforce FKs, but we need user IDs to exist
  // logically.
  await db.execute(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)`);
  await db.execute("INSERT INTO users (id) VALUES (?)", ["user-A"]);
  await db.execute("INSERT INTO users (id) VALUES (?)", ["user-B"]);
  const root = await Deno.makeTempDir({ prefix: "disc-fm-test-" });
  const manager = new FileManager(db, {
    backend: new LocalFileStorage(root),
    maxUploadBytes: 10 * 1024 * 1024
  });
  await manager.initialize();
  return {
    manager,
    db,
    root,
    cleanup: async () => {
      await db.close();
      await Deno.remove(root, { recursive: true });
    }
  };
}

Deno.test("FileManager — upload then read returns the same bytes", async () => {
  const { manager, cleanup } = await setup();
  try {
    const body = new TextEncoder().encode("hello, disc files!");
    const meta = await manager.upload({
      ownerUserId: "user-A",
      name: "greeting.txt",
      contentType: "text/plain",
      body
    });
    assertEquals(meta.size, body.length);
    assertEquals(meta.name, "greeting.txt");
    assertEquals(meta.contentType, "text/plain");
    assert(meta.id.length > 0);
    assertEquals(meta.sha256.length, 64);

    const { metadata, body: got } = await manager.read(meta.id, "user-A");
    assertEquals(metadata.id, meta.id);
    assertEquals(new TextDecoder().decode(got), "hello, disc files!");
  } finally {
    await cleanup();
  }
});

Deno.test("FileManager — content-addressed dedup: same bytes share a single blob", async () => {
  const { manager, root, cleanup } = await setup();
  try {
    const body = new TextEncoder().encode("identical content");
    const a = await manager.upload({ ownerUserId: "user-A", body });
    const b = await manager.upload({ ownerUserId: "user-B", body });
    assertEquals(a.sha256, b.sha256);
    assertEquals(a.storageKey, b.storageKey);

    // Only one underlying blob on disk
    const blobs: string[] = [];
    for await (const entry of walk(root))
      blobs.push(entry);
    assertEquals(blobs.length, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("FileManager — owner-only read: cross-user reads reject", async () => {
  const { manager, cleanup } = await setup();
  try {
    const body = new TextEncoder().encode("private");
    const file = await manager.upload({ ownerUserId: "user-A", body });
    await assertRejects(
      () => manager.read(file.id, "user-B"),
      FileAccessDeniedError
    );
    await assertRejects(
      () => manager.readMetadata(file.id, "user-B"),
      FileAccessDeniedError
    );
  } finally {
    await cleanup();
  }
});

Deno.test("FileManager — list returns only the requesting user's files", async () => {
  const { manager, cleanup } = await setup();
  try {
    await manager.upload({
      ownerUserId: "user-A",
      body: new Uint8Array([1, 2])
    });
    await manager.upload({
      ownerUserId: "user-A",
      body: new Uint8Array([3, 4])
    });
    await manager.upload({
      ownerUserId: "user-B",
      body: new Uint8Array([5, 6])
    });
    const aList = await manager.list("user-A");
    const bList = await manager.list("user-B");
    assertEquals(aList.length, 2);
    assertEquals(bList.length, 1);
    for (const f of aList)
      assertEquals(f.ownerUserId, "user-A");
  } finally {
    await cleanup();
  }
});

Deno.test("FileManager — delete removes metadata and (only when last ref) the blob", async () => {
  const { manager, root, cleanup } = await setup();
  try {
    const body = new TextEncoder().encode("shared");
    const a = await manager.upload({ ownerUserId: "user-A", body });
    const b = await manager.upload({ ownerUserId: "user-B", body });

    // Delete A's metadata; B still references the same blob.
    await manager.delete(a.id, "user-A");
    let blobs: string[] = [];
    for await (const entry of walk(root))
      blobs.push(entry);
    assertEquals(blobs.length, 1, "blob retained while another row references it");

    // Delete B's metadata; now blob is unreferenced and removed.
    await manager.delete(b.id, "user-B");
    blobs = [];
    for await (const entry of walk(root))
      blobs.push(entry);
    assertEquals(blobs.length, 0, "blob removed once unreferenced");
  } finally {
    await cleanup();
  }
});

Deno.test("FileManager — delete rejects cross-user", async () => {
  const { manager, cleanup } = await setup();
  try {
    const file = await manager.upload({
      ownerUserId: "user-A",
      body: new Uint8Array([1])
    });
    await assertRejects(
      () => manager.delete(file.id, "user-B"),
      FileAccessDeniedError
    );
  } finally {
    await cleanup();
  }
});

Deno.test("FileManager — delete on unknown id throws FileNotFoundError", async () => {
  const { manager, cleanup } = await setup();
  try {
    await assertRejects(
      () => manager.delete("00000000-0000-0000-0000-000000000000", "user-A"),
      FileNotFoundError
    );
  } finally {
    await cleanup();
  }
});

Deno.test("FileManager — upload over maxUploadBytes throws FileTooLargeError", async () => {
  const { manager, cleanup } = await setup();
  try {
    const body = new Uint8Array(11 * 1024 * 1024); // 11 MiB > 10 MiB cap
    await assertRejects(
      () => manager.upload({ ownerUserId: "user-A", body }),
      FileTooLargeError
    );
  } finally {
    await cleanup();
  }
});

Deno.test("FileManager — metadata round-trips arbitrary JSON", async () => {
  const { manager, cleanup } = await setup();
  try {
    const file = await manager.upload({
      ownerUserId: "user-A",
      body: new Uint8Array([1]),
      metadata: { tags: ["x", "y"], source: "test", n: 42 }
    });
    const m = await manager.readMetadata(file.id, "user-A");
    assertEquals(m.metadata?.tags, ["x", "y"]);
    assertEquals(m.metadata?.source, "test");
    assertEquals(m.metadata?.n, 42);
  } finally {
    await cleanup();
  }
});

// ── helpers ──────────────────────────────────────────────────────────

async function* walk(root: string): AsyncIterable<string> {
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (entry.isFile && !entry.name.endsWith(".tmp")) {
      yield path;
    }
  }
}
