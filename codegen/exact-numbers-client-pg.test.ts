/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: the generated Go and Rust clients keep every digit of
 * `bigint`, `decimal` and `int64`.
 *
 * The server sends these as exact JSON numbers and reads variables sent as
 * JSON numbers exactly (`server/numeric-precision-pg.test.ts`). Here a client
 * is generated for a schema holding them, built with its own toolchain, and
 * run against a live server: it inserts values no double can hold, reads them
 * back with `Select`, filters on one bound as a variable, and prints what it
 * got.
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
  type PreciseItem {
    required label: str;
    required big: bigint;
    bigs: array<bigint>;
    dec: decimal;
    f64: float64;
    i64: int64;
  }
}`;

const BIG = "12345678901234567890";
const DEC = "0.1000000000000000055511151231257827";
/*** 2^53 + 1: the first integer a double cannot hold. ***/
const I64 = "9007199254740993";

/**
 * What each client program prints: the inserted row, the selected row, the
 * filter's match count, then whether a NaN decimal variable was rejected by
 * the server as Gel's InvalidValueError (decimal has no NaN, so no client ever
 * decodes one). The float64 is 0.5 in both rows: a JSON number in the insert's
 * row as in the select's shape.
 */
const EXPECTED = [
  `inserted ${BIG} ${DEC} ${I64} ${BIG},1 0.5`,
  `selected ${BIG} ${DEC} ${I64} ${BIG},1 0.5`,
  "filtered 1",
  "nan rejected true"
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
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"discclient"
)

func line(label string, item discclient.PreciseItem) string {
	bigs := make([]string, 0, len(*item.Bigs))
	for _, n := range *item.Bigs {
		bigs = append(bigs, n.String())
	}
	return fmt.Sprintf("%s %s %s %d %s %g", label, item.Big, *item.Dec, *item.I64, strings.Join(bigs, ","), *item.F64)
}

func main() {
	builder := discclient.NewPreciseItemQueryBuilder(discclient.NewDiscClient(os.Args[1]))
	bigs := []json.Number{"${BIG}", "1"}
	dec := json.Number("${DEC}")
	i64 := int64(${I64})
	f64 := 0.5
	inserted, err := builder.Insert(discclient.PreciseItemInsert{Label: "go", Big: "${BIG}", Bigs: &bigs, Dec: &dec, F64: &f64, I64: &i64})
	if err != nil {
		panic(err)
	}
	selected, err := builder.Select("")
	if err != nil {
		panic(err)
	}
	filtered, err := builder.Filter(".big = <bigint>$b and .dec = <decimal>$d", map[string]any{"b": json.Number("${BIG}"), "d": dec})
	if err != nil {
		panic(err)
	}
	fmt.Println(line("inserted", inserted))
	fmt.Println(line("selected", selected[0]))
	fmt.Printf("filtered %d\\n", len(filtered))
	_, err = builder.Filter(".dec = <decimal>$d", map[string]any{"d": "NaN"})
	fmt.Printf("nan rejected %t\\n", err != nil && strings.Contains(err.Error(), "invalid value for std::decimal"))
}
`;

const RUST_EXAMPLE = `use disc_client::disc_runtime::DiscClient;
use disc_client::{ExactNumber, PreciseItem, PreciseItemInsert, PreciseItemQueryBuilder};

fn exact(digits: &str) -> ExactNumber {
    ExactNumber(digits.parse().unwrap())
}

fn line(label: &str, item: &PreciseItem) -> String {
    let bigs: Vec<String> = item.bigs.as_ref().unwrap().iter().map(|n| n.0.to_string()).collect();
    format!("{} {} {} {} {} {}", label, item.big.0, item.dec.as_ref().unwrap().0, item.i64.unwrap(), bigs.join(","), item.f64.unwrap())
}

fn main() {
    let port: u16 = std::env::args().nth(1).unwrap().parse().unwrap();
    let client = DiscClient::new("127.0.0.1", port);
    let builder = PreciseItemQueryBuilder::new(&client);
    let inserted = builder
        .insert(PreciseItemInsert {
            label: "rust".to_string(),
            big: exact("${BIG}"),
            bigs: Some(vec![exact("${BIG}"), exact("1")]),
            dec: Some(exact("${DEC}")),
            f64: Some(0.5),
            i64: Some(${I64}),
        })
        .unwrap();
    let selected = builder.select(None).unwrap();
    let variables = serde_json::json!({ "b": exact("${BIG}"), "d": exact("${DEC}") });
    let filtered = builder.filter(Some(".big = <bigint>$b and .dec = <decimal>$d"), variables).unwrap();
    println!("{}", line("inserted", &inserted));
    println!("{}", line("selected", &selected[0]));
    println!("filtered {}", filtered.len());
    let nan = builder.filter(Some(".dec = <decimal>$d"), serde_json::json!({ "d": "NaN" }));
    println!("nan rejected {}", nan.is_err_and(|error| format!("{:?}", error).contains("invalid value for std::decimal")));
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

/*** Apply the schema, serve it over HTTP, and hand `body` the port and schema. ***/
async function withServer(body: (port: number, manager: SchemaManager) => Promise<void>): Promise<void> {
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
    await body(listener.addr.port, manager);
  } finally {
    await listener.shutdown();
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG exact numbers: the generated Go client round-trips bigint, decimal and int64",
  ignore: !canRunPgTests() || !(await toolAvailable("go", ["version"])),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(async (port, manager) => {
      const dir = await Deno.makeTempDir({ prefix: "disc_go_exact_" });
      try {
        await writeFiles(dir, emitGo(schemaToIR(manager.getSchema()!), CONFIG));
        await Deno.mkdir(`${dir}/cmd/roundtrip`, { recursive: true });
        await Deno.writeTextFile(`${dir}/cmd/roundtrip/main.go`, GO_MAIN);
        assertEquals(await run("go", ["run", "./cmd/roundtrip", `http://127.0.0.1:${port}`], dir), EXPECTED);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
});

Deno.test({
  name: "PG exact numbers: the generated Rust client round-trips bigint, decimal and int64",
  ignore: !canRunPgTests() || !(await toolAvailable("cargo", ["--version"])),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(async (port, manager) => {
      const dir = await Deno.makeTempDir({ prefix: "disc_rust_exact_" });
      try {
        await writeFiles(dir, emitRust(schemaToIR(manager.getSchema()!), CONFIG));
        await Deno.mkdir(`${dir}/examples`, { recursive: true });
        await Deno.writeTextFile(`${dir}/examples/roundtrip.rs`, RUST_EXAMPLE);
        assertEquals(await run("cargo", ["run", "--offline", "--quiet", "--example", "roundtrip", "--", String(port)], dir), EXPECTED);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
});
