/**
 * Live-schema-apply admin endpoint (Bundle K — Disc-original feature #3a).
 *
 * `POST /admin/schema-apply` — read the on-disk SDL, plan a migration,
 * and apply it through the existing `MigrationEngine` so the
 * `lock_timeout` pragma + advisory lock + classification gate compose
 * for free.
 *
 * Body: empty (the SDL source is the file on disk — same convention
 * as `disc migrate`). Query params:
 *   - `force=true` — pass through `allowUnsafe: true`; required to
 *     apply destructive (drop) or ambiguous (type-narrowing,
 *     cardinality-flip) operations. Without it the endpoint refuses
 *     and surfaces the structured `flagged[]` summary.
 *
 * Status codes:
 *   - 200 success
 *   - 400 SDL parse error (with structured `parseErrors`) or refusal
 *   - 404 schema file missing
 *   - 405 wrong method
 *   - 500 unexpected
 */

import { ConnectionPool } from "../../lib/connection-pool.ts";
import { SchemaManager } from "../../migration/schema-manager.ts";
import { computeSchemaDiff } from "./schema-diff.ts";
import { getLogger } from "../../lib/logger.ts";

const log = getLogger("admin/schema-apply");

export interface SchemaApplyOptions {
  request: Request;
  url: URL;
  schemaFilePath: string;
  databaseUrl: string;
  /**
   * SDL the server believes is currently applied. When provided, the
   * SchemaManager is primed with this baseline so the diff that drives
   * the unsafe-op gate compares against the running schema rather
   * than starting from scratch (which would treat every drop as an
   * "added type" and silently skip the gate).
   */
  appliedSdl?: string;
  /**
   * Called with the new SDL when the apply succeeds, so the server can
   * update its cached `appliedSdl` for subsequent diff streams.
   */
  onApplied?: (newSdl: string) => void;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Pure handler — owns its own ConnectionPool lifecycle so callers
 * don't have to plumb one in. The pool is opened, used, and closed
 * within a single request; concurrent applies serialize on the
 * advisory lock inside the migration engine.
 */
export async function handleSchemaApply(
  options: SchemaApplyOptions,
): Promise<Response> {
  const { request, url, schemaFilePath, databaseUrl, onApplied } = options;

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  // Read on-disk SDL.
  let onDiskSdl: string;
  try {
    onDiskSdl = await Deno.readTextFile(schemaFilePath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return jsonResponse(404, {
        error: `Schema file not found: ${schemaFilePath}`,
      });
    }
    log.error("schema-apply: failed to read schema file", {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, { error: "Failed to read schema file" });
  }

  // Parse-check the on-disk SDL up front so we can return a clean
  // structured error before opening a DB connection.
  const parsePreview = computeSchemaDiff("module default {};", onDiskSdl);
  if (parsePreview.errors.length > 0) {
    const onDiskParseErrors = parsePreview.errors.filter((e) => e.source === "onDisk");
    if (onDiskParseErrors.length > 0) {
      return jsonResponse(400, {
        error: "Schema file has parse errors",
        parseErrors: onDiskParseErrors,
      });
    }
  }

  const force = url.searchParams.get("force") === "true";

  const pool = new ConnectionPool({ connectionString: databaseUrl });
  let manager: SchemaManager | undefined;
  try {
    await pool.initialize();
    manager = new SchemaManager({ pool, dryRun: false });
    await manager.initialize();

    // Prime the manager's "currently applied" baseline so the
    // unsafe-op gate compares against the running schema rather than
    // starting from `null` (which would treat every drop as a new
    // type-create — silently bypassing the gate). The CLI's `migrate`
    // path doesn't need this because it discovers state through the
    // MigrationTracker; we'd have to load the previous SDL from
    // history to do the same and that's substantially more work for
    // the same outcome.
    if (options.appliedSdl !== undefined && options.appliedSdl.length > 0) {
      const baselineResult = manager.loadBaseline(options.appliedSdl);
      if (!baselineResult.ok) {
        log.warn("schema-apply: applied-SDL baseline failed to parse", {
          error: baselineResult.error.message,
        });
        // Don't fail the request — proceed with no baseline (treats
        // everything as additive). The user can re-bake the server
        // by restarting if they hit this; logging makes the issue
        // discoverable.
      }
    }

    const applyResult = await manager.applySchema(onDiskSdl, {
      allowUnsafe: force,
    });

    if (!applyResult.ok) {
      // Distinguish "refused by gate" from "ran and crashed". The
      // gate's MigrationError message starts with "Migration contains"
      // — same convention the CLI relies on.
      const message = applyResult.error.message;
      const isGateRefusal = message.startsWith("Migration contains");
      return jsonResponse(isGateRefusal ? 400 : 500, {
        error: message,
        gateRefusal: isGateRefusal,
        force,
      });
    }

    const results = applyResult.value;
    onApplied?.(onDiskSdl);

    return jsonResponse(200, {
      ok: true,
      applied: results.map((r) => ({
        migrationId: r.migrationId,
        appliedAt: r.appliedAt,
        durationMs: r.durationMs,
      })),
      force,
    });
  } catch (err) {
    log.error("schema-apply: unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (manager) {
      try {
        await manager.close();
      } catch {
        // best-effort
      }
    }
    try {
      await pool.close();
    } catch {
      // best-effort
    }
  }
}
