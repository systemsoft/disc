/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: the generated Go and Rust clients keep every digit of
 * `bigint`, `decimal` and `int64`, and read and send NaN and ±Infinity floats.
 *
 * The server sends these as exact JSON numbers and reads variables sent as
 * JSON numbers exactly (`server/numeric-precision-pg.test.ts`). Here a client
 * is generated for a schema holding them, built with its own toolchain, and
 * run against a live server: it inserts values no double can hold, reads them
 * back with `Select`, filters on one bound as a variable, and prints what it
 * got.
 *
 * JSON has no number for a NaN or ±Infinity float; the server writes and reads
 * them as the strings "NaN", "Infinity" and "-Infinity" (PostgreSQL's and Gel's
 * JSON form). A client inserts a row holding them in `float64`, `float32` and
 * `array<float64>` fields and reads it back with `Filter`.
 *
 * A `multi` property of `array<float64>` is a slice of float slices in the
 * clients (`[][]float64`, `Vec<Vec<f64>>`). Disc's schema validator rejects a
 * stored one (a PostgreSQL array column can't hold arrays), so the clients are
 * generated from the schema plus a `grid` field of that type (CLIENT_SDL,
 * parsed without validation), which a select fills with a set of arrays
 * (`grid := {.f64s, […]}`); the clients print it, then write it back out as
 * JSON.
 *
 * Requires PostgreSQL (DISC_PG_AUTO=1 or DISC_PG_TEST_URL) and, per test, `go`
 * or `cargo`; without them the test is skipped.
 */

import { assert, assertEquals } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
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
    f32: float32;
    f64: float64;
    f64s: array<float64>;
    i64: int64;
  }
}`;

/*** The schema the clients are generated from: SDL plus a multi property of float arrays, which no stored schema can hold. ***/
const CLIENT_SDL = SDL.replace("    i64: int64;\n", "    i64: int64;\n    multi grid: array<float64>;\n");

/*** The schema the clients are generated from (CLIENT_SDL). ***/
function clientSchema(): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL(CLIENT_SDL, { validate: false });
  if (!parsed.ok)
    throw parsed.error;
  return manager.modulesToSchema(parsed.value);
}

/*** The select filling `grid` with a set of two arrays, one holding NaN and ±Infinity. ***/
const GRID_SHAPE = "{ label, grid := {.f64s, [<float64>'NaN', 0.5]} } filter .label = 'nonfinite'";

const BIG = "12345678901234567890";
const DEC = "0.1000000000000000055511151231257827";
/*** 2^53 + 1: the first integer a double cannot hold. ***/
const I64 = "9007199254740993";

/**
 * What each client program prints: the inserted row, the selected row, the
 * filter's match count, then whether a NaN decimal variable was rejected by
 * the server as Gel's InvalidValueError (decimal has no NaN, so no client ever
 * decodes one). The float64 is 0.5 in both rows: a JSON number in the insert's
 * row as in the select's shape. Last, the non-finite row as the insert
 * returned it and as the filter read it, each float printed as the server's
 * string would be, and the grid as selected and as the client writes it.
 */
const EXPECTED = [
  `inserted ${BIG} ${DEC} ${I64} ${BIG},1 0.5`,
  `selected ${BIG} ${DEC} ${I64} ${BIG},1 0.5`,
  "filtered 1",
  "nan rejected true",
  "nonfinite inserted NaN NaN Infinity,-0.25,-Infinity",
  "nonfinite selected NaN NaN Infinity,-0.25,-Infinity",
  "grid selected Infinity,-0.25,-Infinity;NaN,0.5",
  "grid written [[\"Infinity\",-0.25,\"-Infinity\"],[\"NaN\",0.5]]"
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
	"math"
	"os"
	"strconv"
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

// text prints a float as the server writes it.
func text(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case math.IsInf(x, 1):
		return "Infinity"
	case math.IsInf(x, -1):
		return "-Infinity"
	}
	return strconv.FormatFloat(x, 'g', -1, 64)
}

func nonfinite(label string, item discclient.PreciseItem) string {
	f64s := make([]string, 0, len(*item.F64s))
	for _, x := range *item.F64s {
		f64s = append(f64s, text(x))
	}
	return fmt.Sprintf("nonfinite %s %s %s %s", label, text(*item.F64), text(float64(*item.F32)), strings.Join(f64s, ","))
}

func grid(rows [][]float64) string {
	parts := make([]string, 0, len(rows))
	for _, row := range rows {
		cells := make([]string, 0, len(row))
		for _, x := range row {
			cells = append(cells, text(x))
		}
		parts = append(parts, strings.Join(cells, ","))
	}
	return strings.Join(parts, ";")
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
	nan := math.NaN()
	nan32 := float32(math.NaN())
	f64s := []float64{math.Inf(1), -0.25, math.Inf(-1)}
	special, err := builder.Insert(discclient.PreciseItemInsert{Label: "nonfinite", Big: "1", F32: &nan32, F64: &nan, F64s: &f64s})
	if err != nil {
		panic(err)
	}
	read, err := builder.Filter(".label = 'nonfinite'", nil)
	if err != nil {
		panic(err)
	}
	fmt.Println(nonfinite("inserted", special))
	fmt.Println(nonfinite("selected", read[0]))
	grids, err := builder.Select("${GRID_SHAPE}")
	if err != nil {
		panic(err)
	}
	fmt.Printf("grid selected %s\\n", grid(grids[0].Grid))
	written, err := json.Marshal(discclient.PreciseItemInsert{Label: "grid", Big: "1", Grid: grids[0].Grid})
	if err != nil {
		panic(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(written, &fields); err != nil {
		panic(err)
	}
	fmt.Printf("grid written %s\\n", fields["grid"])
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

/// A float as the server writes it.
fn text(x: f64) -> String {
    if x.is_nan() {
        "NaN".to_string()
    } else if x == f64::INFINITY {
        "Infinity".to_string()
    } else if x == f64::NEG_INFINITY {
        "-Infinity".to_string()
    } else {
        x.to_string()
    }
}

fn nonfinite(label: &str, item: &PreciseItem) -> String {
    let f64s: Vec<String> = item.f64s.as_ref().unwrap().iter().map(|x| text(*x)).collect();
    format!("nonfinite {} {} {} {}", label, text(item.f64.unwrap()), text(item.f32.unwrap() as f64), f64s.join(","))
}

fn grid(rows: &[Vec<f64>]) -> String {
    let parts: Vec<String> = rows.iter().map(|row| row.iter().map(|x| text(*x)).collect::<Vec<String>>().join(",")).collect();
    parts.join(";")
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
            ..Default::default()
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
    let special = builder
        .insert(PreciseItemInsert {
            label: "nonfinite".to_string(),
            big: exact("1"),
            f32: Some(f32::NAN),
            f64: Some(f64::NAN),
            f64s: Some(vec![f64::INFINITY, -0.25, f64::NEG_INFINITY]),
            ..Default::default()
        })
        .unwrap();
    let read = builder.filter(Some(".label = 'nonfinite'"), serde_json::json!({})).unwrap();
    println!("{}", nonfinite("inserted", &special));
    println!("{}", nonfinite("selected", &read[0]));
    let grids = builder.select(Some("${GRID_SHAPE}")).unwrap();
    println!("grid selected {}", grid(&grids[0].grid));
    let written = serde_json::to_value(PreciseItemInsert {
        label: "grid".to_string(),
        big: exact("1"),
        grid: Some(grids[0].grid.clone()),
        ..Default::default()
    })
    .unwrap();
    println!("grid written {}", written["grid"]);
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

/*** Apply the schema, serve it over HTTP, and hand `body` the port. ***/
async function withServer(body: (port: number) => Promise<void>): Promise<void> {
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
    await body(listener.addr.port);
  } finally {
    await listener.shutdown();
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG exact numbers: the generated Go client round-trips bigint, decimal, int64 and non-finite floats",
  ignore: !canRunPgTests() || !(await toolAvailable("go", ["version"])),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(async port => {
      const dir = await Deno.makeTempDir({ prefix: "disc_go_exact_" });
      try {
        await writeFiles(dir, emitGo(schemaToIR(clientSchema()), CONFIG));
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
  name: "PG exact numbers: the generated Rust client round-trips bigint, decimal, int64 and non-finite floats",
  ignore: !canRunPgTests() || !(await toolAvailable("cargo", ["--version"])),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(async port => {
      const dir = await Deno.makeTempDir({ prefix: "disc_rust_exact_" });
      try {
        await writeFiles(dir, emitRust(schemaToIR(clientSchema()), CONFIG));
        await Deno.mkdir(`${dir}/examples`, { recursive: true });
        await Deno.writeTextFile(`${dir}/examples/roundtrip.rs`, RUST_EXAMPLE);
        assertEquals(await run("cargo", ["run", "--offline", "--quiet", "--example", "roundtrip", "--", String(port)], dir), EXPECTED);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
});
