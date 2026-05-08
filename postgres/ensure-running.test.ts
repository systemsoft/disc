import { assertEquals, assertRejects } from "@std/assert";
import type { ProjectContext } from "../lib/project-context.ts";
import { ensurePgRunning } from "./ensure-running.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    backendDsn: undefined,
    dataDir: "/tmp/disc-test/data",
    instanceName: "test-instance",
    managed: true,
    projectName: "test-project",
    projectRoot: "/tmp/disc-test",
    serverHost: "localhost",
    serverPort: 5656,
    socketDir: "/tmp/disc-test/socket",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Guard clause tests — no real PostgreSQL required
// ---------------------------------------------------------------------------

Deno.test(
  "ensurePgRunning - throws for unmanaged instance",
  async () => {
    const ctx = makeCtx({ managed: false });

    await assertRejects(
      () => ensurePgRunning(ctx),
      Error,
      "Not a managed instance"
    );
  }
);

Deno.test(
  "ensurePgRunning - requires managed context",
  async () => {
    const ctx = makeCtx({ managed: false, backendDsn: "postgres://user@host/db" });

    const err = await assertRejects(
      () => ensurePgRunning(ctx),
      Error
    );

    assertEquals(
      (err as Error).message,
      "Not a managed instance — use backendDsn directly"
    );
  }
);
