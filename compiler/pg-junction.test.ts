/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL End-to-End Tests — Junction Table (Many-to-Many) Compilation
 *
 * Tests the full pipeline against real PostgreSQL for many-to-many relationships:
 *   - SDL with reciprocal multi-links → migration → junction table DDL
 *   - INSERT via junction table
 *   - SELECT with nested shape through junction table JOIN
 *   - Reverse direction query through same junction table
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { buildParameterIndex, EdgeQLCompiler } from "./compiler.ts";
import { Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

/**
 * Compile `edgeql` against `schema` and return both the SQL string and the
 * positional values array for `params` (keyed by bare parameter name). Mirrors
 * how the server marshals `$name` references into `$N` bind values, so PG-level
 * round-trip tests can pass arrays/uuids through prepared statements.
 */
function compileWithParams(
  schema: Schema,
  edgeql: string,
  params: Record<string, unknown>
): { sql: string; values: unknown[]; } {
  const ast = new EdgeQLParser(edgeql).parse();
  const parameterIndex = buildParameterIndex(ast);
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast, { parameterMap: parameterIndex });
  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }
  const sql = new SQLCodeGenerator().generate(result.value);
  const values: unknown[] = new Array(parameterIndex.size);
  for (const [name, idx] of parameterIndex) {
    values[idx - 1] = params[name];
  }
  return { sql, values };
}

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function applySchema(
  pool: ConnectionPool,
  sdl: string
): Promise<{ manager: SchemaManager; schema: Schema; }> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  const result = await manager.applySchema(sdl);
  assertEquals(
    result.ok,
    true,
    `applySchema should succeed: ${result.ok ? "" : JSON.stringify(result)}`
  );

  const schema = manager.getSchema();
  assertExists(schema, "Schema should exist after applySchema");

  return { manager, schema: schema! };
}

async function cleanup(
  pool: ConnectionPool,
  tables: string[]
): Promise<void> {
  for (const table of tables) {
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

// =========================================================================
// Many-to-Many: Student <-> Course via junction table
// =========================================================================

// Disc's parser requires `link <name> -> <Target>` for relationships
// (the optional-`link` shorthand from Gel SDL is not supported).
//
// Bidirectional M2M is modeled with ONE stored `multi` link plus a COMPUTED
// backlink on the other side (mutual stored `multi` links are intentionally
// rejected — see the rejection test below). `TestStudent.courses` (stored)
// owns the junction table; `TestCourse.students` is a computed backlink that
// reads the SAME junction in reverse.
const STUDENT_COURSE_SDL = `
  type TestStudent {
    required name: str;
    multi link courses -> TestCourse;
  };
  type TestCourse {
    required title: str;
    students := .<courses[is TestStudent];
  };
`;

const STUDENT_TABLE = "test_student";
const COURSE_TABLE = "test_course";
const JUNCTION_TABLE = "test_student_courses";

Deno.test({
  name: "PG Junction: SDL with reciprocal multi-links creates junction table and supports many-to-many queries",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);

    try {
      await cleanup(pool, [
        JUNCTION_TABLE,
        "test_course_students",
        STUDENT_TABLE,
        COURSE_TABLE
      ]);

      const { schema } = await applySchema(pool, STUDENT_COURSE_SDL);

      // Verify junction table was created
      const tableCheck = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = '${JUNCTION_TABLE}'`
      );
      assertEquals(
        tableCheck.rows.length,
        1,
        `Junction table ${JUNCTION_TABLE} should exist`
      );

      // Insert test data
      const adaId = crypto.randomUUID();
      const billieId = crypto.randomUUID();
      const mathId = crypto.randomUUID();
      const scienceId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO ${STUDENT_TABLE} (id, name) VALUES ($1, 'Ada'), ($2, 'Billie')`,
        [adaId, billieId]
      );
      await pool.query(
        `INSERT INTO ${COURSE_TABLE} (id, title) VALUES ($1, 'Math'), ($2, 'Science')`,
        [mathId, scienceId]
      );

      // Link: Ada -> Math, Science; Billie -> Math
      await pool.query(
        `INSERT INTO ${JUNCTION_TABLE} (source_id, target_id) VALUES ($1, $2), ($1, $3), ($4, $2)`,
        [adaId, mathId, scienceId, billieId]
      );

      // Compile and run: SELECT TestStudent { name, courses: { title } }
      // filtering for Ada
      const sql = compileEdgeQL(
        `SELECT TestStudent { name, courses: { title } } FILTER .name = "Ada"`,
        schema
      );

      const result = await pool.query(sql);
      assertEquals(result.rows.length, 1, "Should return 1 row for Ada");

      const row = result.rows[0];
      const data = typeof row.jsonb_build_object === "string" ?
        JSON.parse(row.jsonb_build_object) :
        row.jsonb_build_object;

      assertEquals(data.name, "Ada");
      assertExists(data.courses, "Should have courses field");

      const courseTitles = data
        .courses
        .map((c: { title: string; }) => c.title)
        .sort();
      assertEquals(courseTitles, ["Math", "Science"]);
    } finally {
      await cleanup(pool, [
        JUNCTION_TABLE,
        "test_course_students",
        STUDENT_TABLE,
        COURSE_TABLE
      ]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Junction: Reverse direction query through junction table returns correct results",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);

    try {
      await cleanup(pool, [
        JUNCTION_TABLE,
        "test_course_students",
        STUDENT_TABLE,
        COURSE_TABLE
      ]);

      const { schema } = await applySchema(pool, STUDENT_COURSE_SDL);

      // Insert test data
      const adaId = crypto.randomUUID();
      const billieId = crypto.randomUUID();
      const mathId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO ${STUDENT_TABLE} (id, name) VALUES ($1, 'Ada'), ($2, 'Billie')`,
        [adaId, billieId]
      );
      await pool.query(
        `INSERT INTO ${COURSE_TABLE} (id, title) VALUES ($1, 'Math')`,
        [mathId]
      );

      // TestCourse.students is a COMPUTED backlink over TestStudent.courses,
      // so there is no second junction table — both students link to Math via
      // the single stored junction (source = student, target = course).
      await pool.query(
        `INSERT INTO ${JUNCTION_TABLE} (source_id, target_id) VALUES ($1, $2), ($3, $2)`,
        [adaId, mathId, billieId]
      );

      // Query from Course side: SELECT TestCourse { title, students: { name } }
      const sql = compileEdgeQL(
        `SELECT TestCourse { title, students: { name } } FILTER .title = "Math"`,
        schema
      );

      const result = await pool.query(sql);
      assertEquals(result.rows.length, 1, "Should return 1 row for Math");

      const row = result.rows[0];
      const data = typeof row.jsonb_build_object === "string" ?
        JSON.parse(row.jsonb_build_object) :
        row.jsonb_build_object;

      assertEquals(data.title, "Math");
      assertExists(data.students, "Should have students field");

      const studentNames = data
        .students
        .map((s: { name: string; }) => s.name)
        .sort();
      assertEquals(studentNames, ["Ada", "Billie"]);
    } finally {
      await cleanup(pool, [
        JUNCTION_TABLE,
        "test_course_students",
        STUDENT_TABLE,
        COURSE_TABLE
      ]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Junction: mutual stored multi-links are rejected (bidirectional M2M must use a computed backlink)",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);

    // Both sides declare a STORED `multi` link to each other. The pairing is
    // ambiguous (the DDL and query layers can't agree on which junction backs
    // which), so applySchema must refuse. The supported form is one stored
    // multi + one computed backlink (see STUDENT_COURSE_SDL above).
    const MUTUAL_SDL = `
      type TestStudent {
        required name: str;
        multi link courses -> TestCourse;
      };
      type TestCourse {
        required title: str;
        multi link students -> TestStudent;
      };
    `;

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const result = await manager.applySchema(MUTUAL_SDL);
      assertEquals(
        result.ok,
        false,
        "applySchema must reject two mutually-stored multi links"
      );
      if (!result.ok) {
        const message = result.error.message;
        const mentionsRejection = message.includes("both sides are stored") ||
          message.includes("Ambiguous bidirectional");
        assertEquals(
          mentionsRejection,
          true,
          `rejection message should explain the ambiguity, got: ${message}`
        );
      }
    } finally {
      await cleanup(pool, [
        JUNCTION_TABLE,
        "test_course_students",
        STUDENT_TABLE,
        COURSE_TABLE
      ]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Junction: One-to-many with backlink still works after junction table changes",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);

    const AUTHOR_TABLE = "test_author";
    const ARTICLE_TABLE = "test_article";

    // One-to-many via a COMPUTED backlink: TestArticle owns the single FK
    // `author`, and TestAuthor.articles reverses it (`.<author[is TestArticle]`).
    // No junction table is involved — the link reads the article FK column.
    const SDL = `
      type TestAuthor {
        required name: str;
        articles := .<author[is TestArticle];
      };
      type TestArticle {
        required title: str;
        required link author -> TestAuthor;
      };
    `;

    try {
      await cleanup(pool, [ARTICLE_TABLE, AUTHOR_TABLE]);

      const { schema } = await applySchema(pool, SDL);

      // Insert test data
      const authorId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO ${AUTHOR_TABLE} (id, name) VALUES ($1, 'Ada')`,
        [authorId]
      );
      await pool.query(
        `INSERT INTO ${ARTICLE_TABLE} (id, title, author_id) VALUES ($1, 'Paper A', $3), ($2, 'Paper B', $3)`,
        [crypto.randomUUID(), crypto.randomUUID(), authorId]
      );

      // One-to-many via backlink (not junction table)
      const sql = compileEdgeQL(
        `SELECT TestAuthor { name, articles: { title } } FILTER .name = "Ada"`,
        schema
      );

      const result = await pool.query(sql);
      assertEquals(result.rows.length, 1);

      const row = result.rows[0];
      const data = typeof row.jsonb_build_object === "string" ?
        JSON.parse(row.jsonb_build_object) :
        row.jsonb_build_object;

      assertEquals(data.name, "Ada");
      const titles = data
        .articles
        .map((a: { title: string; }) => a.title)
        .sort();
      assertEquals(titles, ["Paper A", "Paper B"]);
    } finally {
      await cleanup(pool, [ARTICLE_TABLE, AUTHOR_TABLE]);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Junction: FOR batch INSERT with merged multi-row VALUES works",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);

    const EMP_TABLE = "test_employee";
    const SDL = `
      type TestEmployee {
        required name: str;
        required department: str;
        required salary: int64;
        required active: bool;
      };
    `;

    try {
      await cleanup(pool, [EMP_TABLE]);

      const { schema } = await applySchema(pool, SDL);

      // Compile FOR batch INSERT — should now produce single multi-row INSERT
      const sql = compileEdgeQL(
        `FOR dept IN {"eng", "sales", "ops"}
         UNION (
           INSERT TestEmployee {
             name := "BatchPerson",
             department := dept,
             salary := 50000,
             active := true
           }
         )`,
        schema
      );

      await pool.query(sql);

      const verify = await pool.query(
        `SELECT count(*)::int AS cnt FROM ${EMP_TABLE} WHERE name = 'BatchPerson'`
      );
      assertEquals(
        Number(verify.rows[0].cnt),
        3,
        "Should have 3 batch-inserted rows"
      );
    } finally {
      await cleanup(pool, [EMP_TABLE]);
      await pool.close();
    }
  }
});

// =========================================================================
// Multi-link writes round-trip: INSERT set, UPDATE := / += / -=
// =========================================================================

Deno.test({
  name: "PG Junction: multi-link INSERT/UPDATE round-trip (set, replace, add, remove)",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);

    const SQUAD_TABLE = "test_squad";
    const MEMBER_TABLE = "test_member";
    const SQUAD_JUNCTION = "test_squad_members";

    // Stored multi-link on TestSquad; TestMember has no reciprocal so the
    // SELECT-side reciprocal path (pre-existing, unrelated) is not exercised.
    const SDL = `
      type TestMember {
        required name: str;
      };
      type TestSquad {
        required name: str;
        multi link members -> TestMember;
      };
    `;

    async function junctionTargets(squadId: string): Promise<string[]> {
      const r = await pool.query(
        `SELECT target_id FROM ${SQUAD_JUNCTION} WHERE source_id = $1 ORDER BY target_id`,
        [squadId]
      );
      return r.rows.map(row => String(row.target_id)).sort();
    }

    try {
      await cleanup(pool, [SQUAD_JUNCTION, SQUAD_TABLE, MEMBER_TABLE]);

      const { schema } = await applySchema(pool, SDL);

      const squadId = crypto.randomUUID();
      const m1 = crypto.randomUUID();
      const m2 = crypto.randomUUID();
      const m3 = crypto.randomUUID();

      await pool.query(
        `INSERT INTO ${MEMBER_TABLE} (id, name) VALUES ($1, 'A'), ($2, 'B'), ($3, 'C')`,
        [m1, m2, m3]
      );

      // NOTE: target-set filters use `.id = $a or .id = $b` rather than
      // `.id in array_unpack(<array<uuid>>$ids)` — the latter compiles to an
      // `IN UNNEST(...)` form that is invalid PG (a pre-existing `in`/array
      // gap, orthogonal to Stage 2 junction writes). The OR form exercises the
      // same junction-write CTEs with a valid target-id subquery.

      // INSERT with multi-link set {m1, m2}. Provide the squad id explicitly so
      // we can correlate junction rows.
      const ins = compileWithParams(
        schema,
        `INSERT TestSquad {
           id := <uuid>$sid,
           name := "Alpha",
           members := (select TestMember filter .id = <uuid>$a or .id = <uuid>$b)
         }`,
        { sid: squadId, a: m1, b: m2 }
      );
      await pool.query(ins.sql, ins.values);
      assertEquals(
        await junctionTargets(squadId),
        [m1, m2].sort(),
        "INSERT should create junction rows for {m1, m2}"
      );

      // UPDATE := replace with {m2, m3}
      const replace = compileWithParams(
        schema,
        `UPDATE TestSquad filter .id = <uuid>$sid set {
           members := (select TestMember filter .id = <uuid>$a or .id = <uuid>$b)
         }`,
        { sid: squadId, a: m2, b: m3 }
      );
      await pool.query(replace.sql, replace.values);
      assertEquals(
        await junctionTargets(squadId),
        [m2, m3].sort(),
        "UPDATE := should replace the junction set with {m2, m3}"
      );

      // UPDATE += add {m1, m3} — m3 already present, ON CONFLICT DO NOTHING
      // keeps it a single row.
      const add = compileWithParams(
        schema,
        `UPDATE TestSquad filter .id = <uuid>$sid set {
           members += (select TestMember filter .id = <uuid>$a or .id = <uuid>$b)
         }`,
        { sid: squadId, a: m1, b: m3 }
      );
      await pool.query(add.sql, add.values);
      assertEquals(
        await junctionTargets(squadId),
        [m1, m2, m3].sort(),
        "UPDATE += should add {m1} without duplicating m3"
      );

      // UPDATE -= remove {m2}
      const remove = compileWithParams(
        schema,
        `UPDATE TestSquad filter .id = <uuid>$sid set {
           members -= (select TestMember filter .id = <uuid>$a)
         }`,
        { sid: squadId, a: m2 }
      );
      await pool.query(remove.sql, remove.values);
      assertEquals(
        await junctionTargets(squadId),
        [m1, m3].sort(),
        "UPDATE -= should remove m2"
      );
    } finally {
      await cleanup(pool, [SQUAD_JUNCTION, SQUAD_TABLE, MEMBER_TABLE]);
      await pool.close();
    }
  }
});

// =========================================================================
// Stage 4 end-to-end: the EXACT EdgeQL the generated client emits.
//
// Path used: EdgeQL-form (compile the strings the generated insert()/update()
// bodies build, then bind the array params and run on live PG). The true
// generated-client path is an HTTP client (sdk/client.ts talks to a Disc
// server over /query), and no in-process "codegen → import → call" harness
// exists in this repo, so per the Stage 4 plan we fall back to running the
// same EdgeQL forms. This proves the real runtime path the generated bodies
// depend on: the `array_unpack(<array<uuid>>$x)` membership form bound with a
// JS array param (the Stage 2.5 fix), which the Stage 2 round-trip test above
// deliberately did NOT exercise (it used the `.id = $a or .id = $b` form).
//
// The EdgeQL templates below are copied from the generator's emitted bodies
// (codegen/typescript-generator.ts insert()/update()), substituting the
// concrete type/target names a generated UserQueryBuilder would produce for
// `User.teams -> multi Team`.
// =========================================================================

Deno.test({
  name: "PG Junction (Stage 4 e2e): generated-client EdgeQL forms round-trip multi-link via array params",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);

    const USER_TABLE = "test_user";
    const TEAM_TABLE = "test_team";
    const USER_JUNCTION = "test_user_teams";

    const SDL = `
      type TestTeam {
        required name: str;
      };
      type TestUser {
        required name: str;
        multi link teams -> TestTeam;
      };
    `;

    // Read the link back through a SELECT shape (the same projection a
    // generated select would emit) and return the set of team ids, mirroring
    // how a caller would assert membership via the typed client.
    async function teamsOf(
      schema: Schema,
      userId: string
    ): Promise<string[]> {
      const sql = compileEdgeQL(`SELECT TestUser { id, teams: { id } }`, schema);
      const result = await pool.query(sql);
      for (const row of result.rows) {
        const data = typeof row.jsonb_build_object === "string" ?
          JSON.parse(row.jsonb_build_object) :
          row.jsonb_build_object;
        if (data.id === userId) {
          return (data.teams ?? [])
            .map((t: { id: string; }) => String(t.id))
            .sort();
        }
      }
      return [];
    }

    try {
      await cleanup(pool, [USER_JUNCTION, USER_TABLE, TEAM_TABLE]);

      const { schema } = await applySchema(pool, SDL);

      const userId = crypto.randomUUID();
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      const t3 = crypto.randomUUID();

      await pool.query(
        `INSERT INTO ${TEAM_TABLE} (id, name) VALUES ($1, 'Red'), ($2, 'Blue'), ($3, 'Green')`,
        [t1, t2, t3]
      );

      // insert({ name, teams: [t1, t2] }) — the generated insert() body emits
      //   teams := (select TestTeam filter .id in array_unpack(<array<uuid>>$teams))
      // with `teams` bound to the JS array. We add the explicit id assignment a
      // caller doesn't pass so we can correlate junction rows.
      const ins = compileWithParams(
        schema,
        `insert TestUser {
           id := <uuid>$id,
           name := <str>$name,
           teams := (select TestTeam filter .id in array_unpack(<array<uuid>>$teams))
         }`,
        { id: userId, name: "Ada", teams: [t1, t2] }
      );
      await pool.query(ins.sql, ins.values);
      assertEquals(
        await teamsOf(schema, userId),
        [t1, t2].sort(),
        "insert with teams:[t1,t2] should create both junction rows"
      );

      // update(id, { teams: [t2, t3] }) — array replace branch:
      //   teams := (select TestTeam filter .id in array_unpack(<array<uuid>>$teams))
      const replace = compileWithParams(
        schema,
        `update TestUser filter .id = <uuid>$id set {
           teams := (select TestTeam filter .id in array_unpack(<array<uuid>>$teams))
         }`,
        { id: userId, teams: [t2, t3] }
      );
      await pool.query(replace.sql, replace.values);
      assertEquals(
        await teamsOf(schema, userId),
        [t2, t3].sort(),
        "update replace should make the set exactly {t2, t3}"
      );

      // update(id, { teams: { add: [t1] } }) — delta add branch:
      //   teams += (select TestTeam filter .id in array_unpack(<array<uuid>>$teams__add))
      const add = compileWithParams(
        schema,
        `update TestUser filter .id = <uuid>$id set {
           teams += (select TestTeam filter .id in array_unpack(<array<uuid>>$teams__add))
         }`,
        { id: userId, teams__add: [t1] }
      );
      await pool.query(add.sql, add.values);
      assertEquals(
        await teamsOf(schema, userId),
        [t1, t2, t3].sort(),
        "update delta add should add t1"
      );

      // update(id, { teams: { remove: [t2] } }) — delta remove branch:
      //   teams -= (select TestTeam filter .id in array_unpack(<array<uuid>>$teams__remove))
      const remove = compileWithParams(
        schema,
        `update TestUser filter .id = <uuid>$id set {
           teams -= (select TestTeam filter .id in array_unpack(<array<uuid>>$teams__remove))
         }`,
        { id: userId, teams__remove: [t2] }
      );
      await pool.query(remove.sql, remove.values);
      assertEquals(
        await teamsOf(schema, userId),
        [t1, t3].sort(),
        "update delta remove should drop t2"
      );
    } finally {
      await cleanup(pool, [USER_JUNCTION, USER_TABLE, TEAM_TABLE]);
      await pool.close();
    }
  }
});
