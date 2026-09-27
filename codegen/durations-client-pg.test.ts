/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: the generated Go and Rust clients read `duration`,
 * `cal::relative_duration` and `cal::date_duration` as Gel's ISO 8601 text.
 *
 * The clients keep a duration as the string the server sends (`string`,
 * `String`). A client is generated for a schema holding the three types and
 * an `array<duration>`, built with its own toolchain, and run against a live
 * server: it inserts values written in PostgreSQL's spelling (`1 hour 2
 * minutes`), reads them back with `Select`, and filters on one bound as a
 * variable in ISO spelling (`PT1H2M`). A zero `cal::date_duration` selected
 * in a shape is `P0D`, as in Gel.
 *
 * Requires PostgreSQL (DISC_PG_AUTO=1 or DISC_PG_TEST_URL) and, per test, `go`
 * or `cargo`; without them the test is skipped.
 */

import { assert, assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import { HttpServer } from "../server/http.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { emitGo } from "./emit-go.ts";
import { emitRust } from "./emit-rust.ts";
import { schemaToIR } from "./schema-to-ir.ts";
import type { CodegenConfig, GeneratedFile } from "./types.ts";

const SDL = `module default {
  type Timing {
    required label: str;
    span: duration;
    rel: cal::relative_duration;
    days: cal::date_duration;
    spans: array<duration>;
  }
}`;

/**
 * What each client program prints: the inserted row, the rows selected in
 * label order (the second was inserted with only zero durations), then the
 * count of rows an ISO-spelled variable matches.
 */
const EXPECTED = [
  "inserted PT1H2M P1Y2M3DT4H P3D PT1S,PT-1.5S",
  "selected PT1H2M P1Y2M3DT4H P3D PT1S,PT-1.5S",
  "selected PT0S PT0S P0D -",
  "filtered 1"
]
  .join("\n");

const CONFIG: CodegenConfig = {
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

const GO_MAIN = `package main

import (
	"fmt"
	"os"
	"strings"

	"discclient"
)

func line(label string, item discclient.Timing) string {
	spans := "-"
	if item.Spans != nil {
		spans = strings.Join(*item.Spans, ",")
	}
	return fmt.Sprintf("%s %s %s %s %s", label, *item.Span, *item.Rel, *item.Days, spans)
}

func main() {
	builder := discclient.NewTimingQueryBuilder(discclient.NewDiscClient(os.Args[1]))
	span, rel, days := "1 hour 2 minutes", "1 year 2 months 3 days 4 hours", "3 days"
	spans := []string{"1 second", "-1.5 seconds"}
	inserted, err := builder.Insert(discclient.TimingInsert{Label: "a", Span: &span, Rel: &rel, Days: &days, Spans: &spans})
	if err != nil {
		panic(err)
	}
	zero, zeroDays := "0 seconds", "0 days"
	if _, err := builder.Insert(discclient.TimingInsert{Label: "b", Span: &zero, Rel: &zero, Days: &zeroDays}); err != nil {
		panic(err)
	}
	selected, err := builder.Select("{ label, span, rel, days, spans } order by .label")
	if err != nil {
		panic(err)
	}
	filtered, err := builder.Filter(".span = <duration>$s", map[string]any{"s": "PT1H2M"})
	if err != nil {
		panic(err)
	}
	fmt.Println(line("inserted", discclient.Timing(inserted)))
	for _, item := range selected {
		fmt.Println(line("selected", item))
	}
	fmt.Printf("filtered %d\\n", len(filtered))
}
`;

const RUST_EXAMPLE = `use disc_client::disc_runtime::DiscClient;
use disc_client::{TimingInsert, TimingQueryBuilder};

/// A macro, so it reads a \`Timing\` and the \`TimingMutationResult\` \`insert\` returns alike.
macro_rules! row_line {
    ($label:expr, $item:expr) => {{
        let item = $item;
        let spans = item.spans.as_ref().map(|spans| spans.join(",")).unwrap_or_else(|| "-".to_string());
        format!("{} {} {} {} {}", $label, item.span.as_ref().unwrap(), item.rel.as_ref().unwrap(), item.days.as_ref().unwrap(), spans)
    }};
}

fn main() {
    let port: u16 = std::env::args().nth(1).unwrap().parse().unwrap();
    let client = DiscClient::new("127.0.0.1", port);
    let builder = TimingQueryBuilder::new(&client);
    let inserted = builder
        .insert(TimingInsert {
            label: "a".to_string(),
            span: Some("1 hour 2 minutes".to_string()),
            rel: Some("1 year 2 months 3 days 4 hours".to_string()),
            days: Some("3 days".to_string()),
            spans: Some(vec!["1 second".to_string(), "-1.5 seconds".to_string()]),
            ..Default::default()
        })
        .unwrap();
    builder
        .insert(TimingInsert {
            label: "b".to_string(),
            span: Some("0 seconds".to_string()),
            rel: Some("0 seconds".to_string()),
            days: Some("0 days".to_string()),
            ..Default::default()
        })
        .unwrap();
    let selected = builder.select(Some("{ label, span, rel, days, spans } order by .label")).unwrap();
    let filtered = builder.filter(Some(".span = <duration>$s"), serde_json::json!({ "s": "PT1H2M" })).unwrap();
    println!("{}", row_line!("inserted", &inserted));
    for item in &selected {
        println!("{}", row_line!("selected", item));
    }
    println!("filtered {}", filtered.len());
}
`;

async function toolAvailable(tool: string, args: string[]): Promise<boolean> {
  try {
    return (await new Deno.Command(tool, { args, stderr: "null", stdout: "null" }).output()).success;
  } catch {
    return false;
  }
}

async function writeFiles(dir: string, files: GeneratedFile[]): Promise<void> {
  for (const file of files) {
    const full = `${dir}/${file.path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, file.content);
  }
}

async function run(tool: string, args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command(tool, { args, cwd, stderr: "piped", stdout: "piped" }).output();
  const decoder = new TextDecoder();
  assert(out.success, `${tool} ${args.join(" ")} failed:\n${decoder.decode(out.stderr)}`);
  return decoder.decode(out.stdout).trim();
}

/*** Apply the schema, serve it over HTTP, and hand `body` the port and the schema's IR. ***/
async function withServer(body: (port: number, ir: ReturnType<typeof schemaToIR>) => Promise<void>): Promise<void> {
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

  try {
    await body(listener.addr.port, schemaToIR(schema));
  } finally {
    await listener.shutdown();
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG durations: the generated Go client reads durations as Gel's ISO 8601 text",
  ignore: !canRunPgTests() || !(await toolAvailable("go", ["version"])),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(async (port, ir) => {
      const dir = await Deno.makeTempDir({ prefix: "disc_go_durations_" });
      try {
        await writeFiles(dir, emitGo(ir, CONFIG));
        await Deno.mkdir(`${dir}/cmd/durations`, { recursive: true });
        await Deno.writeTextFile(`${dir}/cmd/durations/main.go`, GO_MAIN);
        assertEquals(await run("go", ["run", "./cmd/durations", `http://127.0.0.1:${port}`], dir), EXPECTED);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
});

Deno.test({
  name: "PG durations: the generated Rust client reads durations as Gel's ISO 8601 text",
  ignore: !canRunPgTests() || !(await toolAvailable("cargo", ["--version"])),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(async (port, ir) => {
      const dir = await Deno.makeTempDir({ prefix: "disc_rust_durations_" });
      try {
        await writeFiles(dir, emitRust(ir, CONFIG));
        await Deno.mkdir(`${dir}/examples`, { recursive: true });
        await Deno.writeTextFile(`${dir}/examples/durations.rs`, RUST_EXAMPLE);
        assertEquals(await run("cargo", ["run", "--offline", "--quiet", "--example", "durations", "--", String(port)], dir), EXPECTED);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
});
