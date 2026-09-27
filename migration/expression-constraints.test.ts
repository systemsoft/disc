/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Type-level `constraint expression on (…)`: a PostgreSQL CHECK on the table
 * of the type and of every concrete subtype.
 *
 * The constraint used to pass validation and produce no DDL at all — the
 * schema read as enforced while PostgreSQL enforced nothing. It now compiles
 * through the EdgeQL compiler to a row-local boolean, is added, changed and
 * dropped by migrations (and undone by rollbacks), and an expression that
 * can't be a CHECK — or any other constraint Disc would drop — is a schema
 * error naming the type and constraint.
 */

import { assert, assertEquals, assertMatch, assertStringIncludes, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { MigrationError, SyntaxError } from "../lib/errors.ts";
import { normalizeModules, SDLConverter, type Module } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import { reconcileConstraintChecks } from "./reconcile.ts";
import { SchemaManager } from "./schema-manager.ts";
import type * as Types from "./types.ts";

/*** Parsed and validated like `disc migrate` does. ***/
function modules(sdl: string): Module[] {
  const parsed = new SchemaManager({}).parseSDL(sdl);
  if (!parsed.ok)
    throw parsed.error;
  return normalizeModules(parsed.value);
}

/*** Parsed without validation, to reach the differ with what the validator would reject. ***/
function unvalidated(sdl: string): Module[] {
  return normalizeModules(new SDLConverter().convertToModules(new SDLParser(sdl).parse()));
}

/*** The error `parseSDL` reports for `sdl`. ***/
function schemaError(sdl: string): string {
  const parsed = new SchemaManager({}).parseSDL(sdl);
  assert(!parsed.ok, "the schema should be rejected");
  return parsed.error.message;
}

function diff(from: string, to: string): Types.MigrationOperation[] {
  return new SchemaDiffer().diff(from === "" ? [] : modules(from), modules(to));
}

function ddl(from: string, to: string): string[] {
  return new DDLGenerator().generateDDL(diff(from, to));
}

function checks(operations: Types.MigrationOperation[]): { kind: string; check: Types.CheckDefinition; }[] {
  return operations
    .filter(op => op.kind === "AddCheck" || op.kind === "DropCheck")
    .map(op => ({ check: (op as Types.AddCheckOperation).check, kind: op.kind }));
}

const PLAIN = `module default { type T { a: int64; b: int64; }; };`;
const ORDERED = `module default { type T { a: int64; b: int64; constraint expression on (.a < .b); }; };`;
const T_DETAIL = "E'violated constraint ''std::expression'' on object type ''default::T'''";

/*** The Gel forge's rule: a comment belongs to exactly one of a bug or a patch. ***/
const FORGE = `
module collab {
  type Bug { title: str; };
  type Patch { title: str; };
  type Comment {
    body: str;
    bug: Bug;
    patch: Patch;
    constraint expression on ((exists .bug) != (exists .patch));
  };
};`;

// ============================================================
// Create, add, change, drop
// ============================================================

Deno.test("expression constraint: adding one to an existing type adds its CHECK (was no DDL at all)", () => {
  const statements = ddl(PLAIN, ORDERED);

  assertEquals(statements.length, 1);
  assertMatch(
    statements[0],
    /^ALTER TABLE t ADD CONSTRAINT ck_t_[0-9a-f]{8} CHECK \(disc_check_constraint\(t\.a < t\.b, E'invalid T', /
  );
  assertStringIncludes(statements[0], T_DETAIL);
});

Deno.test("expression constraint: a new type gets its CHECK after CREATE TABLE", () => {
  const statements = ddl("", ORDERED);
  const create = statements.findIndex(s => s.startsWith("CREATE TABLE t "));
  const check = statements.findIndex(s => s.includes("CHECK (disc_check_constraint(t.a < t.b"));

  assert(create >= 0 && check > create, statements.join("\n"));
});

Deno.test("expression constraint: exactly one of two single links compiles to their FK columns", () => {
  const [op] = checks(diff("", FORGE));

  assertEquals(op.kind, "AddCheck");
  assertEquals(op.check.expression, "(comment.bug_id IS NOT NULL) != (comment.patch_id IS NOT NULL)");
  assertEquals(op.check.message, "invalid Comment");
  assertEquals(op.check.detail, "violated constraint 'std::expression' on object type 'collab::Comment'");
  assertEquals(op.check.declaration, "constraint expression on ((exists .bug) != (exists .patch))");
  assertEquals(op.check.table, "comment");
});

Deno.test("expression constraint: unchanged is no operation; the next diff is empty", () => {
  assertEquals(diff(ORDERED, ORDERED), []);
});

Deno.test("expression constraint: removing it drops its CHECK", () => {
  const [op] = checks(diff(ORDERED, PLAIN));
  const statements = ddl(ORDERED, PLAIN);

  assertEquals(op.kind, "DropCheck");
  assertEquals(statements, [`ALTER TABLE IF EXISTS t DROP CONSTRAINT IF EXISTS ${op.check.name};`]);
});

Deno.test("expression constraint: a changed expression drops the old CHECK first and adds the new one last", () => {
  const changed = `module default { type T { a: int64; b: int64; c: int64; constraint expression on (.a < .c); }; };`;
  const operations = diff(ORDERED, changed);

  assertEquals(operations[0].kind, "DropCheck");
  assertEquals(operations.at(-1)!.kind, "AddCheck");
  assertEquals((operations.at(-1) as Types.AddCheckOperation).check.expression, "t.a < t.c");
  assert(operations.some(op => op.kind === "AlterType"), "the new column is added in between");
});

Deno.test("expression constraint: errmessage becomes the violation message; changing it replaces the CHECK", () => {
  const withMessage = (text: string): string =>
    `module default { type T { a: int64; b: int64; constraint expression on (.a < .b) { errmessage := '${text}'; }; }; };`;

  const [added] = checks(diff(PLAIN, withMessage("a of {__subject__} must be below b")));
  assertEquals(added.check.message, "a of T must be below b");

  const operations = checks(diff(withMessage("one"), withMessage("two")));
  assertEquals(operations.map(op => op.kind), ["DropCheck", "AddCheck"]);
  assertEquals(operations[0].check.name, operations[1].check.name);
  assertEquals(operations[1].check.message, "two");
});

Deno.test("expression constraint: string literals and messages are rendered as escaped SQL literals", () => {
  const sdl = `module default { type T { s: str; constraint expression on (.s != 'it\\'s') { errmessage := "can't be it's"; }; }; };`;
  const [statement] = ddl("", sdl).filter(s => s.includes("CHECK"));

  assertStringIncludes(statement, "disc_check_constraint(t.s != 'it''s', E'can''t be it''s', ");
});

Deno.test("expression constraint: ??, if…else, functions and casts compile to one row's SQL", () => {
  const sdl = `module default { type T {
    a: int64; b: int64; s: str; flag: bool;
    constraint expression on ((.a ?? 0) < (.b ?? 100));
    constraint expression on (true if not exists .b else .a < .b);
    constraint expression on (len(.s) > 2 or .flag);
    constraint expression on (.a != <int64>'7');
  }; };`;
  const expressions = checks(diff("", sdl)).map(op => op.check.expression);

  assertEquals(expressions.length, 4);
  assertStringIncludes(expressions[0], "COALESCE(t.a, 0) < COALESCE(t.b, 100)");
  assertStringIncludes(expressions[1], "WHEN t.b IS NULL THEN TRUE");
  assertStringIncludes(expressions[2], "LENGTH(t.s) > 2");
  assertStringIncludes(expressions[3], "t.a != CAST('7' AS bigint)");
});

Deno.test("expression constraint: the CHECK name fits PostgreSQL's 63 bytes", () => {
  const type = "AVeryLongTypeNameThatKeepsGoingAndGoingPastTheIdentifierLimitOfPostgres";
  const [op] = checks(diff("", `module default { type ${type} { a: int64; constraint expression on (.a > 0); }; };`));

  assert(new TextEncoder().encode(op.check.name).length <= 63, op.check.name);
  assert(op.check.name.startsWith("ck_"));
});

// ============================================================
// Property-level `constraint expression on (__subject__ …)`
// ============================================================

/*** A property-level expression, which the DDL generator used to paste into SQL as text. ***/
const PROP = (constraint: string): string => `module default { type T { name: str { ${constraint} }; }; };`;

Deno.test("property expression: compiles through the compiler — len() and a quoted literal", () => {
  const [op] = checks(diff("", PROP(`constraint expression on (len(__subject__) > 2 and __subject__ != 'it\\'s');`)));

  assertStringIncludes(op.check.expression, "THEN (LENGTH(t.name) > 2) AND (t.name != 'it''s')");
  assertEquals(op.check.message, "invalid name");
  assertEquals(op.check.detail, "violated constraint 'std::expression' on property 'name' of object type 'default::T'");
  assertEquals(op.check.declaration, "constraint expression on ((len(__subject__) > 2) and (__subject__ != 'it\\'s'))");
});

Deno.test("property expression: replaces the CHECK earlier versions pasted from its text", () => {
  const [op] = checks(diff("", PROP("constraint expression on (__subject__ != '');")));
  const [statement] = new DDLGenerator().generateDDL([{ check: op.check, kind: "AddCheck" } as Types.AddCheckOperation]);

  assertEquals(op.check.replaces, "chk_t_name_expression_on___subject_________");
  assertMatch(statement, /^ALTER TABLE t DROP CONSTRAINT IF EXISTS chk_t_name_expression_on___subject_________, ADD CONSTRAINT ck_t_[0-9a-f]{8} CHECK /);
});

Deno.test("property expression: no CHECK of its own from the DDL generator any more", () => {
  const statements = ddl("", PROP("constraint expression on (len(__subject__) > 2);"));

  assertEquals(statements.filter(s => s.includes("CHECK")).length, 1);
  assert(statements.every(s => !s.includes("len(")), statements.join("\n"));
});

Deno.test("property expression: errmessage names the property; inherited properties get it on the subtype", () => {
  const sdl = `module default {
    abstract type Named { name: str { constraint expression on (__subject__ != '') { errmessage := '{__subject__} is empty'; }; }; };
    type Person extending Named {};
  };`;
  const [op] = checks(diff("", sdl));

  assertEquals(op.check.table, "person");
  assertEquals(op.check.message, "name is empty");
  assertEquals(op.check.detail, "violated constraint 'std::expression' on property 'name' of object type 'default::Person'");
});

Deno.test("property expression: what can't be a CHECK is a schema error naming the type, property and constraint", () => {
  assertStringIncludes(
    schemaError(PROP("constraint expression on (__subject__ != global viewer);").replace("module default {", "module default { global viewer: str;")),
    "Type 'default::T', property 'name': 'constraint expression on (__subject__ != global viewer)' can't be enforced — constraint expressions must be immutable, and it reads the global 'viewer'"
  );
  assertStringIncludes(
    schemaError(PROP("constraint expression on (__subject__ != <str>datetime_current());")),
    "constraint expressions must be immutable, and datetime_current() is not"
  );
});

// ============================================================
// Inheritance
// ============================================================

Deno.test("expression constraint: an abstract type's constraint is a CHECK on each concrete subtype, not on the abstract table", () => {
  const sdl = `module default {
    abstract type Base { a: int64; constraint expression on (.a > 0); };
    type Child extending Base { b: str; };
    type Other extending Base {};
  };`;
  const added = checks(diff("", sdl));

  assertEquals(added.map(op => op.check.table).sort(), ["child", "other"]);
  assertEquals(added.find(op => op.check.table === "child")!.check.message, "invalid Child");
  assertEquals(added.find(op => op.check.table === "child")!.check.expression, "child.a > 0");
});

Deno.test("expression constraint: a concrete parent and its subtypes each get the CHECK, own and inherited", () => {
  const sdl = `module default {
    type Parent { a: int64; b: int64; constraint expression on (.a < .b); };
    type Kid extending Parent { constraint expression on (.a > 0); };
  };`;
  const tables = checks(diff("", sdl)).map(op => `${op.check.table}: ${op.check.expression}`).sort();

  assertEquals(tables, ["kid: kid.a < kid.b", "kid: kid.a > 0", "parent: parent.a < parent.b"]);
});

Deno.test("expression constraint: adding one to an abstract type adds the CHECK to existing subtypes' tables", () => {
  const before = `module default { abstract type Base { a: int64; }; type Child extending Base {}; };`;
  const after = `module default { abstract type Base { a: int64; constraint expression on (.a > 0); }; type Child extending Base {}; };`;

  assertEquals(checks(diff(before, after)).map(op => `${op.kind} ${op.check.table}`), ["AddCheck child"]);
});

Deno.test("expression constraint: dropping a type drops its CHECKs with its table", () => {
  const operations = diff(ORDERED, `module default { type Other {}; };`);

  assertEquals(checks(operations), []);
  assert(operations.some(op => op.kind === "DropType"));
});

// ============================================================
// Rollback and repair
// ============================================================

Deno.test("expression constraint: rollback drops an added CHECK and restores a dropped one", () => {
  const generator = new DDLGenerator();
  const [added] = diff(PLAIN, ORDERED) as Types.AddCheckOperation[];
  const [dropped] = diff(ORDERED, PLAIN) as Types.DropCheckOperation[];

  assertEquals(generator.generateRollbackDDL([added]), [`ALTER TABLE IF EXISTS t DROP CONSTRAINT IF EXISTS ${added.check.name};`]);
  assertEquals(generator.generateRollbackDDL([dropped]), generator.generateDDL([added]));
});

Deno.test("expression constraint: rolling back a dropped type recreates its CHECK", () => {
  const forward = diff(ORDERED, `module default { type Other {}; };`);
  const reverse = diff(`module default { type Other {}; };`, ORDERED);
  const statements = new DDLGenerator().generateRollbackDDL(forward, reverse);

  assert(statements.some(s => s.startsWith("CREATE TABLE t ")), statements.join("\n"));
  assert(statements.some(s => s.includes("CHECK (disc_check_constraint(t.a < t.b")), statements.join("\n"));
});

Deno.test("expression constraint: the repair adds a declared CHECK an existing table lacks, and only that", async () => {
  const declared = new SchemaDiffer().declaredChecks(modules(`${ORDERED.slice(0, -3)} type U { x: int64; constraint expression on (.x > 0); }; };`), true);
  const [t, u] = declared;
  const existing = { checks: new Set<string>(), columns: new Set(["t.id", "t.a", "t.b"]) };

  const added = await reconcileConstraintChecks(declared, [], () => Promise.resolve(existing));
  assertEquals(added, [{ check: t, kind: "AddCheck" }], "u doesn't exist yet: the pending migration creates it");

  assertEquals(await reconcileConstraintChecks(declared, [{ check: t, kind: "AddCheck" } as Types.AddCheckOperation], () => Promise.resolve(existing)), []);

  existing.checks.add(`t.${t.name}`);
  assertEquals(await reconcileConstraintChecks(declared, [], () => Promise.resolve(existing)), [], "once there, nothing to repair");
  assertEquals(u.table, "u");
});

// ============================================================
// What can't be a CHECK is an error naming the type and constraint
// ============================================================

const COMMENT = (constraint: string): string =>
  `module default {
  type Bug { title: str; comment: Comment; };
  type Tag {};
  global viewer: str;
  type Comment {
    body: str;
    bug: Bug;
    multi tags: Tag;
    multi scores: int64;
    shout := str_upper(.body);
    created: datetime;
    ${constraint}
  };
};`;

const REJECTED: [string, string][] = [
  ["constraint expression on (.bug.title != '');", "constraints cannot contain paths with more than one hop ('.bug.title')"],
  ["constraint expression on (count(.tags) > 0);", "it calls the aggregate count()"],
  ["constraint expression on (exists .tags);", "it reads the multi link 'tags'"],
  ["constraint expression on (exists .scores);", "it reads the multi property 'scores'"],
  ["constraint expression on (exists .<comment);", "it reads the backlink '.<comment'"],
  ["constraint expression on (.created < datetime_current());", "constraint expressions must be immutable, and datetime_current() is not"],
  ["constraint expression on (exists (select Bug));", "it contains a query"],
  ["constraint expression on (.body != <str>$x);", "it reads the query parameter '$x'"],
  ["constraint expression on (.body != global viewer);", "constraint expressions must be immutable, and it reads the global 'viewer'"],
  ["constraint expression on (.shout != '');", "it reads the computed property 'shout'"],
  ["constraint expression on (.missing > 0);", "'.missing' is not a property or link of 'Comment'"],
  ["constraint expression on (exists Bug);", "it reads every 'Bug' object"]
];

for (const [constraint, reason] of REJECTED) {
  Deno.test(`expression constraint: rejected — ${constraint}`, () => {
    const message = schemaError(COMMENT(constraint));

    assertStringIncludes(message, "Type 'default::Comment': 'constraint expression on (");
    assertStringIncludes(message, reason);
  });
}

Deno.test("expression constraint: the differ refuses what the compiler can't make a CHECK, naming the type and constraint", () => {
  const error = assertThrows(
    () => new SchemaDiffer().diff([], unvalidated(COMMENT("constraint expression on (.bug.title != '');"))),
    MigrationError
  );

  assertStringIncludes(error.message, "Type 'default::Comment': 'constraint expression on (.bug.title != '')' can't be enforced");
  assertStringIncludes(error.message, "it reads more than the object's own row");
});

Deno.test("expression constraint: a stored baseline holding one is read leniently — it never had a CHECK", () => {
  const baseline = unvalidated(COMMENT("constraint expression on (.bug.title != '');"));

  assertEquals(checks(new SchemaDiffer().diff(baseline, modules(COMMENT("")))), []);
});

Deno.test("other constraints Disc would drop are schema errors", () => {
  assertStringIncludes(
    schemaError(`module default { type T { a: int64; constraint min_value(0); }; };`),
    "Type 'default::T': constraint 'min_value' is not supported on an object type"
  );
  assertStringIncludes(
    schemaError(`module default { type T { a: int64; constraint exclusive; }; };`),
    "Type 'default::T': constraint 'exclusive' on an object type needs 'on (…)'"
  );
  assertStringIncludes(
    schemaError(`module default { scalar type Code extending str { constraint exclusive; }; type T { a: Code; }; };`),
    "Scalar type 'default::Code': abstract constraint 'std::exclusive' may not be used on scalar types"
  );
  assertStringIncludes(
    schemaError(`module default { scalar type Code extending str { constraint expression on (.x != ''); }; type T { a: Code; }; };`),
    "Scalar type 'default::Code': 'constraint expression on (.x != '')' can't be enforced — a scalar type's constraint can only read its value, '__subject__'"
  );
  assertStringIncludes(
    schemaError(`module default { type B {}; type T { b: B { constraint expression on (exists __subject__); }; }; };`),
    "Link 'b': constraint 'expression' is not supported on a link"
  );
  assertStringIncludes(
    schemaError(`module default { type B {}; type T { link b -> B { constraint max_value(1); }; }; };`),
    "Link 'b': constraint 'max_value' is not supported on a link"
  );
});

Deno.test("a link's exclusive constraint and a type-level exclusive on (…) still validate", () => {
  modules(`module default { type B {}; type T { a: int64; b: B { constraint exclusive; }; constraint exclusive on ((.a, .b)); }; };`);
});

// ============================================================
// Parsing: xor, and the `;` after a constraint body
// ============================================================

Deno.test("xor is not an operator: SDL says so and suggests != on booleans", () => {
  const message = schemaError(`module default { type T { a: int64; b: int64; constraint expression on (exists .a xor exists .b); }; };`);

  assertStringIncludes(message, "'xor' is not an operator in EdgeQL");
  assertStringIncludes(message, "(exists .a) != (exists .b)");
});

Deno.test("xor is not an operator: EdgeQL says so and suggests != on booleans", () => {
  const error = assertThrows(() => new EdgeQLParser("select User filter exists .a xor exists .b;").parse(), SyntaxError);

  assertEquals(error.message, "'xor' is not an operator in EdgeQL");
  assertStringIncludes(String(error.context?.hint), "(exists .a) != (exists .b)");
});

Deno.test("a constraint body may be followed by ';' inside a property body", () => {
  modules(`module default { type T { age: int32 { constraint min_value(0) { errmessage := "Age must be a non-negative number"; }; }; }; };`);
});
