/**
 * Unit tests for many-to-many junction table compilation
 *
 * Tests the full pipeline for multi-link junction table SQL generation:
 * - EdgeQL SELECT with junction-backed multi-links compiles to INNER JOIN SQL
 * - Reciprocal links use the same junction table with swapped columns
 * - DDLGenerator deduplicates junction tables across both sides of a M2M pair
 * - SchemaManager.modulesToSchema() detects M2M and sets junctionTable on both LinkDefs
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { DDLGenerator } from "../migration/ddl.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema, LinkDef, PropertyDef, Schema, TypeDef } from "./context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compile an EdgeQL string against the given schema and return the generated
 * SQL string (original casing preserved for JOIN/INNER/WHERE assertions).
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
  return codegen.generate(result.value);
}

/**
 * Build a minimal Schema with User and Team types connected by a junction
 * table via User.memberships (multi -> Team).
 *
 * User.memberships has junctionTable="user_memberships" with the standard
 * source_id -> users, target_id -> teams column mapping.
 *
 * Team has no reciprocal multi-link in this helper — it is added separately
 * by the reciprocal test.
 *
 * Note: "groups" and "Group" are avoided because they conflict with the
 * EdgeQL parser's GROUP keyword. "Team"/"memberships" are used instead.
 */
function createUserTeamSchema(): Schema {
  const baseSchema = createTestSchema();

  const teamType: TypeDef = {
    name: "Team",
    kind: "object",
    tableName: "teams",
    properties: new Map<string, PropertyDef>([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str"
      }]
    ]),
    links: new Map<string, LinkDef>()
  };

  // Add a memberships multi-link to User that uses a junction table
  const userType = baseSchema.types.get("User")!;
  const updatedLinks = new Map(userType.links);
  updatedLinks.set("memberships", {
    name: "memberships",
    target: "Team",
    required: false,
    multi: true,
    junctionTable: "user_memberships",
    junctionSourceColumn: "source_id",
    junctionTargetColumn: "target_id"
  });

  const updatedUser: TypeDef = {
    ...userType,
    links: updatedLinks
  };

  const types = new Map(baseSchema.types);
  types.set("User", updatedUser);
  types.set("Team", teamType);

  return { types, functions: getBuiltinFunctions() };
}

/**
 * Build a Schema where Team also has a reciprocal multi-link back to User,
 * using the SAME junction table with SWAPPED source/target columns.
 *
 * Team.members: junctionTable="user_memberships", junctionSourceColumn="target_id"
 * (the Team side of the junction), junctionTargetColumn="source_id" (the User side).
 */
function createReciprocalSchema(): Schema {
  const schema = createUserTeamSchema();

  const teamType = schema.types.get("Team")!;
  const updatedTeamLinks = new Map(teamType.links);
  updatedTeamLinks.set("members", {
    name: "members",
    target: "User",
    required: false,
    multi: true,
    // Same junction table, columns swapped for the reverse direction
    junctionTable: "user_memberships",
    junctionSourceColumn: "target_id",
    junctionTargetColumn: "source_id"
  });

  const updatedTeam: TypeDef = {
    ...teamType,
    links: updatedTeamLinks
  };

  const types = new Map(schema.types);
  types.set("Team", updatedTeam);

  return { types, functions: getBuiltinFunctions() };
}

// ---------------------------------------------------------------------------
// Test 1: Junction table link with shape
// ---------------------------------------------------------------------------

Deno.test("Junction compilation - SELECT User { name, memberships: { name } } uses INNER JOIN through junction", () => {
  const schema = createUserTeamSchema();

  const sql = compileWithSchema(
    schema,
    "SELECT User { name, memberships: { name } }"
  );

  const lower = sql.toLowerCase();

  // The junction table must appear in the SQL
  assertStringIncludes(
    lower,
    "user_memberships",
    "SQL should reference junction table user_memberships"
  );

  // An INNER JOIN must be present to traverse the junction table
  assertEquals(
    lower.includes("inner join"),
    true,
    "SQL should contain an INNER JOIN clause to traverse the junction table"
  );

  // The ON condition should join the junction table to the target (teams)
  assertStringIncludes(
    lower,
    "target_id",
    "SQL should reference target_id from junction table in ON condition"
  );

  // The WHERE condition should correlate the junction back to the parent (users)
  assertStringIncludes(
    lower,
    "source_id",
    "SQL should reference source_id from junction table in WHERE condition"
  );

  // The shape fields should appear in the output
  assertStringIncludes(
    lower,
    "'name'",
    "SQL should include the name shape field"
  );

  // The subquery should aggregate results via jsonb_agg
  assertStringIncludes(
    lower,
    "jsonb_agg",
    "SQL should aggregate junction results with jsonb_agg"
  );
});

// ---------------------------------------------------------------------------
// Test 2: Junction table link reference without shape
// ---------------------------------------------------------------------------

Deno.test("Junction compilation - SELECT User { memberships } without shape generates subquery through junction", () => {
  const schema = createUserTeamSchema();

  const sql = compileWithSchema(
    schema,
    "SELECT User { name, memberships }"
  );

  const lower = sql.toLowerCase();

  // The junction table must appear in the SQL even without an explicit shape
  assertStringIncludes(
    lower,
    "user_memberships",
    "SQL should reference junction table user_memberships"
  );

  // source_id must be referenced for the WHERE correlation to the parent
  assertStringIncludes(
    lower,
    "source_id",
    "SQL should reference source_id from junction table"
  );

  // The output should still be JSON
  assertStringIncludes(
    lower,
    "jsonb_build_object",
    "SQL should produce jsonb_build_object output"
  );
});

// ---------------------------------------------------------------------------
// Test 3: Reciprocal junction table (reverse direction)
// ---------------------------------------------------------------------------

Deno.test("Junction compilation - SELECT Team { name, members: { name } } uses same junction with swapped columns", () => {
  const schema = createReciprocalSchema();

  const sql = compileWithSchema(
    schema,
    "SELECT Team { name, members: { name } }"
  );

  const lower = sql.toLowerCase();

  // Must still reference the canonical junction table name
  assertStringIncludes(
    lower,
    "user_memberships",
    "SQL should reference the shared junction table user_memberships"
  );

  // An INNER JOIN must be present
  assertEquals(
    lower.includes("inner join"),
    true,
    "SQL should contain an INNER JOIN clause"
  );

  // The reciprocal direction uses target_id as the junction source (Team side)
  // and source_id as the junction target (User side)
  assertStringIncludes(
    lower,
    "target_id",
    "SQL should reference target_id (Team side of junction in ON condition)"
  );
  assertStringIncludes(
    lower,
    "source_id",
    "SQL should reference source_id (User side of junction in WHERE condition)"
  );

  // The members shape should yield the name field from User
  assertStringIncludes(
    lower,
    "'name'",
    "SQL should include the name shape field from User members"
  );

  // Results should be aggregated
  assertStringIncludes(
    lower,
    "jsonb_agg",
    "SQL should aggregate members with jsonb_agg"
  );

  // The FROM clause should query the users table (not teams) for the subquery
  assertStringIncludes(
    lower,
    "users",
    "SQL subquery should select from users table for the members link"
  );
});

// ---------------------------------------------------------------------------
// Test 4: DDL deduplication — reciprocal M2M produces only one junction table
// ---------------------------------------------------------------------------

Deno.test("DDL deduplication - reciprocal multi-links create exactly one junction table", () => {
  const generator = new DDLGenerator();

  // Simulate two CreateType operations — one for each side of a many-to-many
  // relationship between Student and Course.
  const operations = [
    {
      kind: "CreateType" as const,
      typeName: "Student",
      properties: [
        {
          name: "name",
          type: "str",
          required: true,
          multi: false,
          constraints: [],
          annotations: {}
        }
      ],
      links: [
        {
          name: "courses",
          target: "Course",
          required: false,
          multi: true,
          annotations: {}
        }
      ]
    },
    {
      kind: "CreateType" as const,
      typeName: "Course",
      properties: [
        {
          name: "title",
          type: "str",
          required: true,
          multi: false,
          constraints: [],
          annotations: {}
        }
      ],
      links: [
        {
          name: "students",
          target: "Student",
          required: false,
          multi: true,
          annotations: {}
        }
      ]
    }
  ];

  const ddl = generator.generateDDL(operations);
  const combinedDDL = ddl.join("\n");

  // Count CREATE TABLE statements in the generated DDL.
  // We expect:
  //   1 CREATE TABLE for student
  //   1 CREATE TABLE for course
  //   1 CREATE TABLE for the junction (exactly one, not two)
  // Total: 3
  const createTableMatches = combinedDDL.match(/CREATE TABLE/gi) ?? [];

  assertEquals(
    createTableMatches.length,
    3,
    `Expected exactly 3 CREATE TABLE statements (student, course, one junction), got ${createTableMatches.length}:\n${combinedDDL}`
  );

  // Verify the junction table is created under exactly one canonical name.
  // DDLGenerator names the junction after the first-processed type:
  // student is processed first, so the junction table is "student_courses".
  assertStringIncludes(
    combinedDDL.toLowerCase(),
    "create table student_courses",
    "DDL should create the junction table student_courses (named after the first type)"
  );

  // The reverse name must NOT also have a CREATE TABLE — that would be a duplicate.
  assertEquals(
    combinedDDL.toLowerCase().includes("create table course_students"),
    false,
    "DDL must not create course_students — deduplication should suppress the second junction table"
  );
});

// ---------------------------------------------------------------------------
// Test 5: SchemaManager M2M detection sets junctionTable on both LinkDefs
// ---------------------------------------------------------------------------

Deno.test("SchemaManager - M2M detection sets junctionTable on both LinkDefs", () => {
  // The SDL parser requires the "multi link X -> Y" arrow syntax.
  const sdl = `
    type Student {
      required name: str;
      multi link courses -> Course;
    }
    type Course {
      required title: str;
      multi link students -> Student;
    }
  `;

  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);

  assertEquals(
    parseResult.ok,
    true,
    `SDL parsing should succeed: ${parseResult.ok ? "" : parseResult.error?.message}`
  );

  if (!parseResult.ok) {
    return;
  }

  const schema = manager.modulesToSchema(parseResult.value);

  const studentType = schema.types.get("Student");
  const courseType = schema.types.get("Course");

  assertEquals(
    studentType !== undefined,
    true,
    "Student type should exist in schema"
  );
  assertEquals(
    courseType !== undefined,
    true,
    "Course type should exist in schema"
  );

  if (!studentType || !courseType) {
    return;
  }

  const coursesLink = studentType.links.get("courses");
  const studentsLink = courseType.links.get("students");

  assertEquals(
    coursesLink !== undefined,
    true,
    "Student.courses link should exist"
  );
  assertEquals(
    studentsLink !== undefined,
    true,
    "Course.students link should exist"
  );

  if (!coursesLink || !studentsLink) {
    return;
  }

  // Both links must have junctionTable set (M2M was detected)
  assertEquals(
    coursesLink.junctionTable !== undefined,
    true,
    "Student.courses should have junctionTable set"
  );
  assertEquals(
    studentsLink.junctionTable !== undefined,
    true,
    "Course.students should have junctionTable set"
  );

  // The forward direction (Student -> Course) is processed first and
  // assigns the canonical junction-table name `student_courses`. Both
  // sides share this single physical table — the reciprocal pass
  // updates Course.students to point at the same name with source/target
  // columns swapped, so SELECT TestCourse.students walks the same
  // junction rows from the other end.
  assertEquals(
    coursesLink.junctionTable,
    "student_courses",
    "Student.courses junctionTable should follow the ${sourceTable}_${linkName} convention"
  );
  assertEquals(
    coursesLink.junctionSourceColumn,
    "source_id",
    "Student.courses junctionSourceColumn should be source_id"
  );
  assertEquals(
    coursesLink.junctionTargetColumn,
    "target_id",
    "Student.courses junctionTargetColumn should be target_id"
  );

  // Course.students shares the same physical table with swapped columns.
  assertEquals(
    studentsLink.junctionTable,
    "student_courses",
    "Course.students should reuse the canonical Student-side junction table"
  );
  assertEquals(
    studentsLink.junctionSourceColumn,
    "target_id",
    "Course.students junctionSourceColumn should be target_id (swapped)"
  );
  assertEquals(
    studentsLink.junctionTargetColumn,
    "source_id",
    "Course.students junctionTargetColumn should be source_id (swapped)"
  );
});
