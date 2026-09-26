/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * The generated TypeScript client must pass `deno check` against the SDK it
 * ships with. Pins two defects a downstream schema hit:
 *
 * - Enums declared in a non-default module were emitted twice (TS2300), because
 *   `modulesToSchema` registers them under both the bare and the qualified name.
 * - Every `filter()` passed `FilterArg<XFilter>` to a `compileFilter` constrained
 *   to `Record<string, unknown>`, which an index-signature-free interface can't
 *   satisfy (TS2345, one per object type).
 *
 * Also pins that `writeGeneratedFiles` formats its output when the project's
 * `deno.json` excludes the output directory from `deno fmt`.
 */

/*** NATIVE ------------------------------------------- ***/

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import type { Schema } from "../compiler/context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { cleanupTempDir, createTempDir } from "../tests/test-utils.ts";

/*** RUNTIME ------------------------------------------ ***/

import { generateTypeScript, writeGeneratedFiles } from "./mod.ts";
import { schemaToIR } from "./schema-to-ir.ts";

const SDL = `
module default {
  type Note {
    required body: str;
  }
}

module agents {
  scalar type AgentCapability extending enum<Read, Write, Admin>;
  scalar type AgentStatus extending enum<Idle, Busy, Offline>;

  type Agent {
    required name: str;
    required status: AgentStatus;
    multi capabilities: AgentCapability;
    created: datetime {
      default := datetime_current();
    };
  }

  type Task {
    required title: str;
    status: AgentStatus;
    agent: Agent;
  }

  type Team {
    required name: str;
    multi members: Agent;
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

async function run(args: string[], cwd?: string): Promise<{ ok: boolean; output: string; }> {
  const result = await new Deno.Command(Deno.execPath(), { args, cwd, stderr: "piped", stdout: "piped" }).output();
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  return { ok: result.success, output };
}

/** Copy the source SDK (what `disc codegen` materializes next to the client) into `targetDir`. */
async function copySdk(targetDir: string): Promise<void> {
  const sdkDir = new URL("../sdk/", import.meta.url);
  await Deno.mkdir(targetDir, { recursive: true });

  for await (const entry of Deno.readDir(sdkDir)) {
    if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      await Deno.copyFile(new URL(entry.name, sdkDir), join(targetDir, entry.name));
  }
}

Deno.test("codegen typecheck - an enum in a non-default module is emitted once", () => {
  const agents = schemaToIR(schema()).modules.find(m => m.name === "agents");
  assert(agents, "expected an agents module");
  assertEquals(agents.enums.map(e => e.name.name), ["AgentCapability", "AgentStatus"]);
});

Deno.test("codegen typecheck - the generated client passes deno check", async () => {
  const tempDir = await createTempDir();

  try {
    const result = generateTypeScript(schema(), { outputDir: "disc-client" });
    assertEquals(result.errors, []);
    await writeGeneratedFiles(result, tempDir, { runFmt: false });
    await copySdk(join(tempDir, "disc-client", "sdk"));

    const { ok, output } = await run(["check", "--no-config", "disc-client/index.ts"], tempDir);
    assert(ok, `generated client should pass deno check; output:\n${output}`);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("codegen typecheck - output is formatted even when deno.json excludes it from fmt", async () => {
  const tempDir = await createTempDir();

  try {
    await Deno.writeTextFile(join(tempDir, "deno.json"), JSON.stringify({ fmt: { exclude: ["dbschema/"] } }));
    const result = generateTypeScript(schema(), { outputDir: "dbschema/disc-client" });
    await writeGeneratedFiles(result, tempDir);

    const { ok, output } = await run(["fmt", "--check", "--no-config", "dbschema/disc-client/"], tempDir);
    assert(ok, `generated files should already be formatted; output:\n${output}`);
  } finally {
    await cleanupTempDir(tempDir);
  }
});
