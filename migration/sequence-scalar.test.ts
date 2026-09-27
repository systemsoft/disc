/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Sequence scalars: `scalar type TicketNo extending sequence;` is Gel's
 * auto-incrementing int64. The sequence belongs to the scalar, not to a
 * property: every property of type `TicketNo` draws from the same counter.
 *
 * Disc creates one PostgreSQL sequence per sequence scalar (`disc_seq_<name>`,
 * `disc_seq_<module>__<name>` outside the default module), before any column
 * that uses it; such a property is a BIGINT column defaulting to the next
 * value. Dropping the scalar drops the sequence, after the columns.
 *
 * Also: a schema spelled with `std::` names is the same schema as the one
 * spelled with bare names, so switching spellings migrates nothing.
 *
 * Real-PG coverage lives in `migration/sequence-scalar-pg.test.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import { SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import { MigrationEngine } from "./engine.ts";
import * as Types from "./types.ts";

function parseModules(src: string) {
  return new SDLConverter().convertToModules(new SDLParser(src).parse());
}

function engine(): MigrationEngine {
  return new MigrationEngine({
    autoApprove: true,
    backupBeforeMigration: false,
    databaseUrl: "",
    dryRun: true,
    migrationsDir: "",
    rollbackOnError: false,
    schemaFile: ""
  } as Types.MigrationConfig);
}

/*** The forward and rollback DDL of migrating `from` to `to`, whitespace collapsed. ***/
function migrate(from: string | null, to: string): { forward: string[]; operations: Types.MigrationOperation[]; rollback: string[]; } {
  const e = engine();
  const plan = e.planMigration(from === null ? null : parseModules(from), parseModules(to));
  assert(plan.ok, "expected plan to succeed");
  const statements = e.generateDDL(plan.value);
  assert(statements.ok, "expected DDL generation to succeed");
  const operations = plan.value.migrations.flatMap(migration => migration.operations);
  const rollback = new DDLGenerator().generateRollbackDDL(operations);
  const collapse = (sql: string[]): string[] => sql.map(s => s.replace(/\s+/g, " ").trim());
  return { forward: collapse(statements.value), operations, rollback: collapse(rollback) };
}

const TICKETS = `module default {
  scalar type TicketNo extending sequence;
  type Ticket {
    required title: str;
    number: TicketNo;
  };
  type Refund {
    required number: TicketNo;
    explicit: TicketNo {
      default := 100;
    };
  };
};
module billing {
  scalar type InvoiceNo extending std::sequence;
  type Invoice {
    number: InvoiceNo;
  };
};`;

Deno.test("sequence scalar - a sequence per scalar, created before the tables that use it", () => {
  const { forward } = migrate(null, TICKETS);
  const createSeq = forward.indexOf("CREATE SEQUENCE disc_seq_ticketno;");
  const createInvoiceSeq = forward.indexOf("CREATE SEQUENCE disc_seq_billing__invoiceno;");
  const createTicket = forward.findIndex(s => s.startsWith("CREATE TABLE ticket "));
  const createInvoice = forward.findIndex(s => s.startsWith("CREATE TABLE invoice "));

  assert(createSeq >= 0, forward.join("\n"));
  assert(createInvoiceSeq >= 0, forward.join("\n"));
  assert(createSeq < createTicket, forward.join("\n"));
  assert(createInvoiceSeq < createInvoice, forward.join("\n"));
});

Deno.test("sequence scalar - its properties are BIGINT columns defaulting to the scalar's sequence", () => {
  const { forward } = migrate(null, TICKETS);
  const table = (name: string): string => forward.find(s => s.startsWith(`CREATE TABLE ${name} `)) ?? "";

  assert(table("ticket").includes("number BIGINT DEFAULT nextval('disc_seq_ticketno')"), table("ticket"));
  assert(table("refund").includes("number BIGINT NOT NULL DEFAULT nextval('disc_seq_ticketno')"), table("refund"));
  assert(table("refund").includes("explicit BIGINT DEFAULT 100"), table("refund"));
  assert(table("invoice").includes("number BIGINT DEFAULT nextval('disc_seq_billing__invoiceno')"), table("invoice"));
});

Deno.test("sequence scalar - adding a property of a sequence scalar adds a defaulted column", () => {
  const { forward } = migrate(
    `module default { scalar type TicketNo extending sequence; type Ticket { required title: str; }; };`,
    `module default { scalar type TicketNo extending sequence; type Ticket { required title: str; number: TicketNo; }; };`
  );

  assert(
    forward.includes("ALTER TABLE ticket ADD COLUMN number BIGINT NULL DEFAULT nextval('disc_seq_ticketno');"),
    forward.join("\n")
  );
});

Deno.test("sequence scalar - dropping the scalar drops its sequence after the columns", () => {
  const { forward } = migrate(
    `module default { scalar type TicketNo extending sequence; type Ticket { required title: str; number: TicketNo; }; };`,
    `module default { type Ticket { required title: str; }; };`
  );
  const dropColumn = forward.findIndex(s => s.includes("DROP COLUMN") && s.includes("number"));
  const dropSeq = forward.indexOf("DROP SEQUENCE IF EXISTS disc_seq_ticketno;");

  assert(dropColumn >= 0, forward.join("\n"));
  assert(dropSeq > dropColumn, forward.join("\n"));
  assert(!forward.some(s => s.includes("DROP TYPE")), forward.join("\n"));
});

Deno.test("sequence scalar - rolling back its creation drops the sequence; rolling back its drop recreates it", () => {
  const created = migrate(null, TICKETS);
  assert(created.rollback.includes("DROP SEQUENCE IF EXISTS disc_seq_ticketno;"), created.rollback.join("\n"));
  assert(created.rollback.includes("DROP SEQUENCE IF EXISTS disc_seq_billing__invoiceno;"), created.rollback.join("\n"));

  const dropped = migrate(`module default { scalar type TicketNo extending sequence; };`, `module default { };`);
  assert(dropped.rollback.includes("CREATE SEQUENCE IF NOT EXISTS disc_seq_ticketno;"), dropped.rollback.join("\n"));
});

// A scalar extending a sequence scalar is a sequence too, with a counter of
// its own: Gel creates a sequence for every scalar that is a subtype of
// `std::sequence` (edb/pgsql/delta.py `CreateScalarType`, `is_sequence` =
// `issubclass(std::sequence)`), and a property defaults to the next value of
// its own scalar's sequence (`get_pointer_default`).
const CHAIN = `module default {
  scalar type Base extending sequence;
  scalar type Sub extending Base;
  scalar type Leaf extending Sub;
  type Counter {
    base: Base;
    sub: Sub;
    leaf: Leaf;
  };
};
module billing {
  scalar type Batch extending default::Base;
  type Run {
    batch: Batch;
  };
};`;

Deno.test("sequence scalar - a scalar extending a sequence scalar gets its own sequence and default", () => {
  const { forward } = migrate(null, CHAIN);
  const table = (name: string): string => forward.find(s => s.startsWith(`CREATE TABLE ${name} `)) ?? "";
  const counter = forward.findIndex(s => s.startsWith("CREATE TABLE counter "));
  for (const sequence of ["disc_seq_base", "disc_seq_sub", "disc_seq_leaf", "disc_seq_billing__batch"]) {
    const created = forward.indexOf(`CREATE SEQUENCE ${sequence};`);
    assert(created >= 0 && created < counter, `${sequence}:\n${forward.join("\n")}`);
  }

  assert(table("counter").includes("base BIGINT DEFAULT nextval('disc_seq_base')"), table("counter"));
  assert(table("counter").includes("sub BIGINT DEFAULT nextval('disc_seq_sub')"), table("counter"));
  assert(table("counter").includes("leaf BIGINT DEFAULT nextval('disc_seq_leaf')"), table("counter"));
  assert(table("run").includes("batch BIGINT DEFAULT nextval('disc_seq_billing__batch')"), table("run"));
});

Deno.test("sequence scalar - a derived sequence scalar's sequence is dropped with it and restored on rollback", () => {
  const created = migrate(null, CHAIN);
  for (const sequence of ["disc_seq_sub", "disc_seq_leaf", "disc_seq_billing__batch"])
    assert(created.rollback.includes(`DROP SEQUENCE IF EXISTS ${sequence};`), created.rollback.join("\n"));

  const dropped = migrate(
    `module default { scalar type Base extending sequence; scalar type Sub extending Base; type T { sub: Sub; }; };`,
    `module default { scalar type Base extending sequence; type T { }; };`
  );
  const dropColumn = dropped.forward.findIndex(s => s.includes("DROP COLUMN") && s.includes("sub"));
  const dropSeq = dropped.forward.indexOf("DROP SEQUENCE IF EXISTS disc_seq_sub;");
  assert(dropColumn >= 0 && dropSeq > dropColumn, dropped.forward.join("\n"));
  assert(!dropped.forward.some(s => s.includes("disc_seq_base")), dropped.forward.join("\n"));
  assert(dropped.rollback.includes("CREATE SEQUENCE IF NOT EXISTS disc_seq_sub;"), dropped.rollback.join("\n"));
});

Deno.test("std:: names - the same schema spelled with std:: names needs no migration", () => {
  const bare = `module default {
  scalar type Count extending int64;
  type Item {
    required name: str;
    big: bigint;
    tags: array<str>;
    span: range<int64>;
    count: Count;
  };
};`;
  const qualified = bare
    .replace("extending int64", "extending std::int64")
    .replace("name: str", "name: std::str")
    .replace("big: bigint", "big: std::bigint")
    .replace("array<str>", "array<std::str>")
    .replace("range<int64>", "range<std::int64>");

  assertEquals(new SchemaDiffer().diff(parseModules(bare), parseModules(qualified)), []);

  const { forward } = migrate(null, qualified);
  const create = forward.find(s => s.startsWith("CREATE TABLE item ")) ?? "";
  for (const column of ["name TEXT NOT NULL", "big NUMERIC", "tags TEXT[]", "span INT8RANGE", "count BIGINT"])
    assert(create.includes(column), `${column}: ${create}`);
});
