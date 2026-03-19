/**
 * Calendar Type Support Tests
 *
 * Verifies that all five cal:: types are correctly handled across the
 * Disc compilation pipeline: compiler type mapping, DDL generation,
 * codegen type mapping, cast map, schema validation, and schema-manager
 * SQL type mapping.
 *
 * The five calendar types:
 *   cal::local_date       -> PG date
 *   cal::local_time       -> PG time without time zone
 *   cal::local_datetime   -> PG timestamp without time zone
 *   cal::relative_duration -> PG interval
 *   cal::date_duration    -> PG interval
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { DDLGenerator } from "../migration/ddl.ts";
import * as MigrationTypes from "../migration/types.ts";
import * as Types from "../codegen/types.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { Schema } from "./context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse SDL source into a compiler-ready Schema via SchemaManager.
 */
function createSchemaFromSDL(sdl: string): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);
  if (!parseResult.ok) {
    throw parseResult.error;
  }
  return manager.modulesToSchema(parseResult.value);
}

/**
 * Compile an EdgeQL query string against the given schema and return the
 * generated SQL (lowercased for easy assertion).
 */
function compileWithSchema(schema: Schema, edgeql: string): string {
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema);
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value).toLowerCase();
}

// ============================================================
// 1. Type mapping in compiler (via query compilation)
// ============================================================

const CAL_SDL = `
  type Event {
    required title: str;
    event_date: cal::local_date;
    event_time: cal::local_time;
    event_datetime: cal::local_datetime;
    event_rel_duration: cal::relative_duration;
    event_date_duration: cal::date_duration;
  }
`;

const calSchema = createSchemaFromSDL(CAL_SDL);

Deno.test("Compiler type mapping - schema has cal-typed properties", () => {
  const eventType = calSchema.types.get("Event");
  assertEquals(eventType !== undefined, true);

  const props = eventType!.properties;
  assertEquals(props.has("event_date"), true);
  assertEquals(props.has("event_time"), true);
  assertEquals(props.has("event_datetime"), true);
  assertEquals(props.has("event_rel_duration"), true);
  assertEquals(props.has("event_date_duration"), true);
});

Deno.test("Compiler type mapping - cal::local_date property has edgeqlType set", () => {
  const prop = calSchema.types.get("Event")!.properties.get("event_date")!;
  assertEquals(prop.edgeqlType, "cal::local_date");
});

Deno.test("Compiler type mapping - cal::local_time property has edgeqlType set", () => {
  const prop = calSchema.types.get("Event")!.properties.get("event_time")!;
  assertEquals(prop.edgeqlType, "cal::local_time");
});

Deno.test("Compiler type mapping - cal::local_datetime property has edgeqlType set", () => {
  const prop = calSchema.types.get("Event")!.properties.get(
    "event_datetime",
  )!;
  assertEquals(prop.edgeqlType, "cal::local_datetime");
});

Deno.test("Compiler type mapping - cal::relative_duration property has edgeqlType set", () => {
  const prop = calSchema.types.get("Event")!.properties.get(
    "event_rel_duration",
  )!;
  assertEquals(prop.edgeqlType, "cal::relative_duration");
});

Deno.test("Compiler type mapping - cal::date_duration property has edgeqlType set", () => {
  const prop = calSchema.types.get("Event")!.properties.get(
    "event_date_duration",
  )!;
  assertEquals(prop.edgeqlType, "cal::date_duration");
});

Deno.test("Compiler type mapping - SELECT with cal-typed properties compiles to valid SQL", () => {
  const sql = compileWithSchema(
    calSchema,
    `
    SELECT Event {
      title,
      event_date,
      event_time,
      event_datetime
    }
  `,
  );
  assertStringIncludes(sql, "jsonb_build_object");
  assertStringIncludes(sql, "'title'");
  assertStringIncludes(sql, "'event_date'");
  assertStringIncludes(sql, "'event_time'");
  assertStringIncludes(sql, "'event_datetime'");
});

Deno.test("Compiler type mapping - SELECT with duration-typed properties compiles to valid SQL", () => {
  const sql = compileWithSchema(
    calSchema,
    `
    SELECT Event {
      title,
      event_rel_duration,
      event_date_duration
    }
  `,
  );
  assertStringIncludes(sql, "'event_rel_duration'");
  assertStringIncludes(sql, "'event_date_duration'");
});

// ============================================================
// 2. DDL generation
// ============================================================

Deno.test("DDL Generator - cal::local_date generates DATE column", () => {
  const generator = new DDLGenerator();
  const operation: MigrationTypes.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Event",
    properties: [
      {
        name: "event_date",
        type: "cal::local_date",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));
  assertEquals(createTable !== undefined, true);
  assertStringIncludes(createTable!, "DATE");
});

Deno.test("DDL Generator - cal::local_time generates TIME WITHOUT TIME ZONE column", () => {
  const generator = new DDLGenerator();
  const operation: MigrationTypes.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Event",
    properties: [
      {
        name: "event_time",
        type: "cal::local_time",
        required: false,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));
  assertEquals(createTable !== undefined, true);
  assertStringIncludes(createTable!, "TIME WITHOUT TIME ZONE");
});

Deno.test("DDL Generator - cal::local_datetime generates TIMESTAMP WITHOUT TIME ZONE column", () => {
  const generator = new DDLGenerator();
  const operation: MigrationTypes.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Event",
    properties: [
      {
        name: "event_datetime",
        type: "cal::local_datetime",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));
  assertEquals(createTable !== undefined, true);
  assertStringIncludes(createTable!, "TIMESTAMP WITHOUT TIME ZONE");
});

Deno.test("DDL Generator - cal::relative_duration generates INTERVAL column", () => {
  const generator = new DDLGenerator();
  const operation: MigrationTypes.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Event",
    properties: [
      {
        name: "rel_duration",
        type: "cal::relative_duration",
        required: false,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));
  assertEquals(createTable !== undefined, true);
  assertStringIncludes(createTable!, "INTERVAL");
});

Deno.test("DDL Generator - cal::date_duration generates INTERVAL column", () => {
  const generator = new DDLGenerator();
  const operation: MigrationTypes.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "Event",
    properties: [
      {
        name: "date_dur",
        type: "cal::date_duration",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"));
  assertEquals(createTable !== undefined, true);
  assertStringIncludes(createTable!, "INTERVAL");
});

Deno.test("DDL Generator - type with all five cal types generates correct columns", () => {
  const generator = new DDLGenerator();
  const operation: MigrationTypes.CreateTypeOperation = {
    kind: "CreateType",
    typeName: "CalendarEntry",
    properties: [
      {
        name: "entry_date",
        type: "cal::local_date",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
      {
        name: "entry_time",
        type: "cal::local_time",
        required: false,
        multi: false,
        constraints: [],
        annotations: {},
      },
      {
        name: "entry_datetime",
        type: "cal::local_datetime",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
      {
        name: "reminder_offset",
        type: "cal::relative_duration",
        required: false,
        multi: false,
        constraints: [],
        annotations: {},
      },
      {
        name: "recurrence_interval",
        type: "cal::date_duration",
        required: false,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const statements = generator.generateDDL([operation]);
  const createTable = statements.find((s) => s.startsWith("CREATE TABLE"))!;

  assertStringIncludes(createTable, "DATE");
  assertStringIncludes(createTable, "TIME WITHOUT TIME ZONE");
  assertStringIncludes(createTable, "TIMESTAMP WITHOUT TIME ZONE");
  // INTERVAL appears for both duration types
  assertStringIncludes(createTable, "INTERVAL");
});

// ============================================================
// 3. Codegen type mapping
// ============================================================

Deno.test("Codegen - cal::local_datetime maps to Date (required)", () => {
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::local_datetime", true, false),
    "Date",
  );
});

Deno.test("Codegen - cal::local_datetime maps to Date | null (optional)", () => {
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::local_datetime", false, false),
    "Date | null",
  );
});

Deno.test("Codegen - cal::local_date maps to string (required)", () => {
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::local_date", true, false),
    "string",
  );
});

Deno.test("Codegen - cal::local_date maps to string | null (optional)", () => {
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::local_date", false, false),
    "string | null",
  );
});

Deno.test("Codegen - cal::local_time maps to string (required)", () => {
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::local_time", true, false),
    "string",
  );
});

Deno.test("Codegen - cal::local_time maps to string[] (multi)", () => {
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::local_time", true, true),
    "string[]",
  );
});

Deno.test("Codegen - cal::relative_duration maps to string (required)", () => {
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::relative_duration", true, false),
    "string",
  );
});

Deno.test("Codegen - cal::relative_duration maps to string[] (multi)", () => {
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::relative_duration", true, true),
    "string[]",
  );
});

Deno.test("Codegen - cal::date_duration maps to string (required)", () => {
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::date_duration", true, false),
    "string",
  );
});

Deno.test("Codegen - cal::date_duration maps to string | null (optional)", () => {
  assertEquals(
    Types.mapEdgeQLTypeToTypeScript("cal::date_duration", false, false),
    "string | null",
  );
});

Deno.test("Codegen - getTypeMapping returns mappings for all five cal types", () => {
  const calTypes = [
    "cal::local_date",
    "cal::local_time",
    "cal::local_datetime",
    "cal::relative_duration",
    "cal::date_duration",
  ];

  for (const calType of calTypes) {
    const mapping = Types.getTypeMapping(calType);
    assertEquals(mapping !== null, true, `Missing mapping for ${calType}`);
    assertEquals(
      mapping!.edgeqlType,
      calType,
      `Mapping edgeqlType mismatch for ${calType}`,
    );
  }
});

// ============================================================
// 4. Cast map
// ============================================================

Deno.test("Cast map - cal::local_date casts to <cal::local_date>", () => {
  assertEquals(
    Types.mapEdgeQLTypeToEdgeQLCast("cal::local_date"),
    "<cal::local_date>",
  );
});

Deno.test("Cast map - cal::local_time casts to <cal::local_time>", () => {
  assertEquals(
    Types.mapEdgeQLTypeToEdgeQLCast("cal::local_time"),
    "<cal::local_time>",
  );
});

Deno.test("Cast map - cal::local_datetime casts to <cal::local_datetime>", () => {
  assertEquals(
    Types.mapEdgeQLTypeToEdgeQLCast("cal::local_datetime"),
    "<cal::local_datetime>",
  );
});

Deno.test("Cast map - cal::relative_duration casts to <cal::relative_duration>", () => {
  assertEquals(
    Types.mapEdgeQLTypeToEdgeQLCast("cal::relative_duration"),
    "<cal::relative_duration>",
  );
});

Deno.test("Cast map - cal::date_duration casts to <cal::date_duration>", () => {
  assertEquals(
    Types.mapEdgeQLTypeToEdgeQLCast("cal::date_duration"),
    "<cal::date_duration>",
  );
});

// ============================================================
// 5. Schema validation
// ============================================================

Deno.test("Schema validation - cal::local_date is recognized as valid built-in type", () => {
  const sdl = `type Meeting { required start_date: cal::local_date; }`;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Schema validation - cal::local_time is recognized as valid built-in type", () => {
  const sdl = `type Meeting { required start_time: cal::local_time; }`;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Schema validation - cal::local_datetime is recognized as valid built-in type", () => {
  const sdl = `type Meeting { required scheduled_at: cal::local_datetime; }`;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Schema validation - cal::relative_duration is recognized as valid built-in type", () => {
  const sdl = `type Meeting { duration: cal::relative_duration; }`;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Schema validation - cal::date_duration is recognized as valid built-in type", () => {
  const sdl = `type Subscription { period: cal::date_duration; }`;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Schema validation - all five cal types in one type are valid", () => {
  const sdl = `
    type CalendarEvent {
      required event_date: cal::local_date;
      required event_time: cal::local_time;
      required event_datetime: cal::local_datetime;
      reminder_offset: cal::relative_duration;
      recurrence: cal::date_duration;
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Schema validation - min_value constraint allowed on cal::local_date", () => {
  const sdl = `
    type Booking {
      required check_in: cal::local_date {
        constraint min_value('2020-01-01');
      };
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

Deno.test("Schema validation - max_value constraint allowed on cal::local_datetime", () => {
  const sdl = `
    type Reservation {
      required deadline: cal::local_datetime {
        constraint max_value('2030-12-31T23:59:59');
      };
    }
  `;
  const parser = new SDLParser(sdl);
  const doc = parser.parse();
  const validator = new SchemaValidator();
  const result = validator.validate(doc);
  assertEquals(result.ok, true);
});

// ============================================================
// 6. SDL_TO_SQL_TYPE_MAP via sdlTypeToSqlType (schema-manager)
// ============================================================

Deno.test("sdlTypeToSqlType - cal::local_date maps to date", () => {
  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(
    `type T { required d: cal::local_date; }`,
  );
  assertEquals(parseResult.ok, true);
  const schema = manager.modulesToSchema(parseResult.value);
  const prop = schema.types.get("T")!.properties.get("d")!;
  assertEquals(prop.type, "date");
});

Deno.test("sdlTypeToSqlType - cal::local_time maps to time", () => {
  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(
    `type T { required t: cal::local_time; }`,
  );
  assertEquals(parseResult.ok, true);
  const schema = manager.modulesToSchema(parseResult.value);
  const prop = schema.types.get("T")!.properties.get("t")!;
  assertEquals(prop.type, "time");
});

Deno.test("sdlTypeToSqlType - cal::local_datetime maps to timestamp", () => {
  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(
    `type T { required dt: cal::local_datetime; }`,
  );
  assertEquals(parseResult.ok, true);
  const schema = manager.modulesToSchema(parseResult.value);
  const prop = schema.types.get("T")!.properties.get("dt")!;
  assertEquals(prop.type, "timestamp");
});

Deno.test("sdlTypeToSqlType - cal::relative_duration maps to interval", () => {
  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(
    `type T { required rd: cal::relative_duration; }`,
  );
  assertEquals(parseResult.ok, true);
  const schema = manager.modulesToSchema(parseResult.value);
  const prop = schema.types.get("T")!.properties.get("rd")!;
  assertEquals(prop.type, "interval");
});

Deno.test("sdlTypeToSqlType - cal::date_duration maps to interval", () => {
  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(
    `type T { required dd: cal::date_duration; }`,
  );
  assertEquals(parseResult.ok, true);
  const schema = manager.modulesToSchema(parseResult.value);
  const prop = schema.types.get("T")!.properties.get("dd")!;
  assertEquals(prop.type, "interval");
});
