/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for CustomFunctionsExtension
 */

import { assertEquals, assertThrows } from "@std/assert";
import { ExtensionConfigError } from "../extensions/errors.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import { CustomFunctionsExtension } from "./extension.ts";
import type { CustomFunctionsConfig } from "./types.ts";

// ── Test helpers ──────────────────────────────────────────────────────

function makeContext(): ExtensionContext {
  return {
    schema: { types: new Map(), functions: new Map() },
    config: {
      host: "localhost",
      port: 5656,
      databaseUrl: "postgres://localhost/disc_test",
      maxConnections: 5,
      requestTimeout: 5000,
      enableCors: false,
      enableWebsockets: false
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function() {
        return this;
      },
      withRequest: function() {
        return this;
      }
    } as unknown as ExtensionContext["logger"]
  };
}

// ── Metadata ──────────────────────────────────────────────────────────

Deno.test("CustomFunctionsExtension - metadata has correct name", () => {
  const ext = new CustomFunctionsExtension({ functions: [] });
  assertEquals(ext.metadata.name, "custom-functions");
});

Deno.test("CustomFunctionsExtension - metadata has correct version", () => {
  const ext = new CustomFunctionsExtension({ functions: [] });
  assertEquals(ext.metadata.version, "1.0.0");
});

// ── Constructor validation ────────────────────────────────────────────

Deno.test("CustomFunctionsExtension - constructor throws ExtensionConfigError when functions is missing", () => {
  assertThrows(
    () => new CustomFunctionsExtension({} as CustomFunctionsConfig),
    ExtensionConfigError,
    "functions array is required"
  );
});

Deno.test("CustomFunctionsExtension - constructor throws ExtensionConfigError when functions is not an array", () => {
  assertThrows(
    () =>
      new CustomFunctionsExtension(
        { functions: "not-an-array" } as unknown as CustomFunctionsConfig
      ),
    ExtensionConfigError,
    "functions array is required"
  );
});

// ── initialize ────────────────────────────────────────────────────────

Deno.test("CustomFunctionsExtension - initialize sets state to ready (no pool)", async () => {
  const ext = new CustomFunctionsExtension({ functions: [] });
  await ext.initialize(makeContext());
  assertEquals(ext.state, "ready");
});

// ── getFunctions ──────────────────────────────────────────────────────

Deno.test("CustomFunctionsExtension - getFunctions returns FunctionDef for sql_name implementation", () => {
  const ext = new CustomFunctionsExtension({
    functions: [
      {
        name: "my_lower",
        args: [{ name: "input", type: "str", required: true }],
        returnType: "str",
        implementation: { kind: "sql_name", sqlName: "lower" }
      }
    ]
  });

  const fns = ext.getFunctions();
  assertEquals(fns.length, 1);
  assertEquals(fns[0].name, "my_lower");
  assertEquals(fns[0].sqlName, "lower");
  assertEquals(fns[0].returnType, "str");
  assertEquals(fns[0].args.length, 1);
  assertEquals(fns[0].args[0].name, "input");
  assertEquals(fns[0].args[0].type, "str");
  assertEquals(fns[0].args[0].required, true);
});

Deno.test("CustomFunctionsExtension - getFunctions returns FunctionDef for sql_expression implementation", () => {
  const ext = new CustomFunctionsExtension({
    functions: [
      {
        name: "double_val",
        args: [{ name: "n", type: "int64" }],
        returnType: "int64",
        implementation: { kind: "sql_expression", expression: "$1 * 2" }
      }
    ]
  });

  const fns = ext.getFunctions();
  assertEquals(fns.length, 1);
  assertEquals(fns[0].sqlName, "$1 * 2");
});

Deno.test("CustomFunctionsExtension - getFunctions returns FunctionDef for plpgsql implementation", () => {
  const ext = new CustomFunctionsExtension({
    functions: [
      {
        name: "greet",
        args: [{ name: "username", type: "str" }],
        returnType: "str",
        implementation: {
          kind: "plpgsql",
          body: "BEGIN\n  RETURN 'Hello, ' || username;\nEND;"
        }
      }
    ]
  });

  const fns = ext.getFunctions();
  assertEquals(fns.length, 1);
  assertEquals(fns[0].name, "greet");
  assertEquals(fns[0].sqlName, "greet"); // plpgsql uses own name
});

Deno.test("CustomFunctionsExtension - getFunctions defaults required to true when omitted", () => {
  const ext = new CustomFunctionsExtension({
    functions: [
      {
        name: "noop",
        args: [{ name: "val", type: "str" }], // required omitted
        returnType: "str",
        implementation: { kind: "sql_name", sqlName: "noop" }
      }
    ]
  });

  const fns = ext.getFunctions();
  assertEquals(fns[0].args[0].required, true);
});

Deno.test("CustomFunctionsExtension - getFunctions returns empty array when no functions configured", () => {
  const ext = new CustomFunctionsExtension({ functions: [] });
  assertEquals(ext.getFunctions().length, 0);
});

// ── getDatabaseSetup ──────────────────────────────────────────────────

Deno.test("CustomFunctionsExtension - getDatabaseSetup returns CREATE SQL only for plpgsql functions", () => {
  const ext = new CustomFunctionsExtension({
    functions: [
      {
        name: "pg_func",
        args: [],
        returnType: "str",
        implementation: {
          kind: "plpgsql",
          body: "BEGIN\n  RETURN 'ok';\nEND;"
        }
      },
      {
        name: "sql_alias",
        args: [],
        returnType: "str",
        implementation: { kind: "sql_name", sqlName: "lower" }
      }
    ]
  });

  const setup = ext.getDatabaseSetup();
  assertEquals(setup.setupSql.length, 1);
  assertEquals(
    setup.setupSql[0].includes("CREATE OR REPLACE FUNCTION pg_func"),
    true
  );
});

Deno.test("CustomFunctionsExtension - getDatabaseSetup returns DROP SQL for all functions", () => {
  const ext = new CustomFunctionsExtension({
    functions: [
      {
        name: "pg_func",
        args: [],
        returnType: "str",
        implementation: {
          kind: "plpgsql",
          body: "BEGIN\n  RETURN 'ok';\nEND;"
        }
      },
      {
        name: "sql_alias",
        args: [{ name: "input", type: "str" }],
        returnType: "str",
        implementation: { kind: "sql_name", sqlName: "lower" }
      }
    ]
  });

  const setup = ext.getDatabaseSetup();
  assertEquals(setup.teardownSql?.length, 2);
  assertEquals(
    setup.teardownSql?.some(s => s.includes("DROP FUNCTION IF EXISTS pg_func")),
    true
  );
  assertEquals(
    setup.teardownSql?.some(s => s.includes("DROP FUNCTION IF EXISTS sql_alias")),
    true
  );
});

Deno.test("CustomFunctionsExtension - getDatabaseSetup returns empty setup for sql_name only config", () => {
  const ext = new CustomFunctionsExtension({
    functions: [
      {
        name: "my_upper",
        args: [{ name: "input", type: "str" }],
        returnType: "str",
        implementation: { kind: "sql_name", sqlName: "upper" }
      }
    ]
  });

  const setup = ext.getDatabaseSetup();
  assertEquals(setup.setupSql.length, 0);
  assertEquals(setup.teardownSql?.length, 1);
});
