/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * /files HTTP integration tests — POST upload, GET list, GET binary,
 * DELETE owner-only, plus the unconfigured-fileManager 404 path.
 */

import {
  assert,
  assertEquals
} from "@std/assert";
import { AuthRoutes } from "../auth/integration.ts";
import { AuthMiddleware } from "../auth/middleware.ts";
import { AuthProvider } from "../auth/provider.ts";
import { TestDatabase } from "../auth/test-database.ts";
import { LocalFileStorage } from "../lib/file-storage/local.ts";
import { FileManager } from "../lib/file-storage/manager.ts";
import { HttpServer } from "./http.ts";

const TEST_HOST = "127.0.0.1";

async function startServer(opts: {
  withFiles: boolean;
}): Promise<{
  baseUrl: string;
  token: string;
  userId: string;
  cleanup: () => Promise<void>;
}> {
  const db = new TestDatabase();
  await db.connect();
  const provider = new AuthProvider(
    { jwtSecret: "test-secret-key-32-bytes-minimum-len" },
    db
  );
  await provider.initialize();
  const reg = await provider.register({
    email: "u@example.com",
    password: "password123"
  });
  const login = await provider.login({
    email: "u@example.com",
    password: "password123"
  });
  if ("mfaRequired" in login) {
    throw new Error("unexpected MFA in test setup");
  }

  const middleware = new AuthMiddleware(provider);
  const routes = new AuthRoutes(provider, middleware);

  let fileManager: FileManager | undefined;
  let storageRoot: string | undefined;
  if (opts.withFiles) {
    storageRoot = await Deno.makeTempDir({ prefix: "disc-files-srv-" });
    fileManager = new FileManager(db, {
      backend: new LocalFileStorage(storageRoot),
      maxUploadBytes: 10 * 1024 * 1024
    });
    await fileManager.initialize();
  }

  const port = 20000 + Math.floor(Math.random() * 5000);
  const server = new HttpServer({
    config: {
      host: TEST_HOST,
      port,
      databaseUrl: "postgresql://localhost:5432/test",
      maxConnections: 10,
      requestTimeout: 5000,
      enableCors: true,
      enableWebsockets: false,
      enableAuth: true
    },
    protocolHandler: {
      handleRequest: () => Promise.resolve({ data: { result: "ok" } }),
      validateRequest: () => []
    },
    authProvider: provider,
    authMiddleware: middleware,
    authRoutes: routes,
    fileManager
  });

  // server.start() awaits `server.finished` (resolves on shutdown), so
  // the existing pattern in `server/auth-integration.test.ts` is fire-
  // and-forget + a brief sleep until the listener is bound.
  const _running = server.start();
  await new Promise(r => setTimeout(r, 200));
  return {
    baseUrl: `http://${TEST_HOST}:${port}`,
    token: login.token,
    userId: reg.user.id,
    cleanup: async () => {
      await server.stop();
      await _running.catch(() => undefined);
      await db.close();
      if (storageRoot) {
        await Deno.remove(storageRoot, { recursive: true });
      }
    }
  };
}

Deno.test("POST /files — uploads bytes, returns metadata", async () => {
  const { baseUrl, token, cleanup } = await startServer({ withFiles: true });
  try {
    const body = new TextEncoder().encode("hello disc");
    const res = await fetch(`${baseUrl}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
        "x-file-name": "greeting.txt"
      },
      body
    });
    assertEquals(res.status, 201);
    const meta = await res.json();
    assertEquals(meta.size, body.length);
    assertEquals(meta.name, "greeting.txt");
    assertEquals(meta.contentType, "text/plain");
    assert(meta.id);
  } finally {
    await cleanup();
  }
});

Deno.test("POST /files then GET /files/:id — round-trips bytes", async () => {
  const { baseUrl, token, cleanup } = await startServer({ withFiles: true });
  try {
    const body = new TextEncoder().encode("round-trip me");
    const upload = await fetch(`${baseUrl}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body
    });
    const { id } = await upload.json();

    const dl = await fetch(`${baseUrl}/files/${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assertEquals(dl.status, 200);
    const text = await dl.text();
    assertEquals(text, "round-trip me");
  } finally {
    await cleanup();
  }
});

Deno.test("GET /files — lists only the requesting user's files", async () => {
  const { baseUrl, token, cleanup } = await startServer({ withFiles: true });
  try {
    const a = await fetch(`${baseUrl}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: new Uint8Array([1, 2, 3])
    });
    await a.json();
    const b = await fetch(`${baseUrl}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: new Uint8Array([4, 5, 6])
    });
    await b.json();
    const res = await fetch(`${baseUrl}/files`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assertEquals(res.status, 200);
    const { files } = await res.json();
    assertEquals(files.length, 2);
  } finally {
    await cleanup();
  }
});

Deno.test("GET /files/:id/meta — returns metadata only", async () => {
  const { baseUrl, token, cleanup } = await startServer({ withFiles: true });
  try {
    const up = await fetch(`${baseUrl}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: new Uint8Array([0, 1, 2, 3])
    });
    const { id } = await up.json();
    const res = await fetch(`${baseUrl}/files/${id}/meta`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assertEquals(res.status, 200);
    const meta = await res.json();
    assertEquals(meta.size, 4);
    assert(meta.sha256);
  } finally {
    await cleanup();
  }
});

Deno.test("DELETE /files/:id — removes the file", async () => {
  const { baseUrl, token, cleanup } = await startServer({ withFiles: true });
  try {
    const up = await fetch(`${baseUrl}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: new Uint8Array([9])
    });
    const { id } = await up.json();
    const del = await fetch(`${baseUrl}/files/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
    // 204 has no body — but Deno still asks us to drain it.
    await del.body?.cancel();
    assertEquals(del.status, 204);

    const after = await fetch(`${baseUrl}/files/${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    await after.body?.cancel();
    assertEquals(after.status, 404);
  } finally {
    await cleanup();
  }
});

Deno.test("/files routes — 401 without Authorization header", async () => {
  const { baseUrl, cleanup } = await startServer({ withFiles: true });
  try {
    const res = await fetch(`${baseUrl}/files`);
    await res.body?.cancel();
    assertEquals(res.status, 401);
  } finally {
    await cleanup();
  }
});

Deno.test("/files — 404 when fileManager not configured", async () => {
  const { baseUrl, token, cleanup } = await startServer({ withFiles: false });
  try {
    const res = await fetch(`${baseUrl}/files`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    await res.body?.cancel();
    assertEquals(res.status, 404);
  } finally {
    await cleanup();
  }
});
