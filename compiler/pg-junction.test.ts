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
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { Schema } from "./context.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0,
  });
}

function compileEdgeQL(edgeql: string, schema: Schema): string {
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);

  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }

  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value);
}

async function applySchema(
  pool: ConnectionPool,
  sdl: string,
): Promise<{ manager: SchemaManager; schema: Schema }> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  const result = await manager.applySchema(sdl);
  assertEquals(
    result.ok,
    true,
    `applySchema should succeed: ${result.ok ? "" : JSON.stringify(result)}`,
  );

  const schema = manager.getSchema();
  assertExists(schema, "Schema should exist after applySchema");

  return { manager, schema: schema! };
}

async function cleanup(
  pool: ConnectionPool,
  tables: string[],
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

const STUDENT_COURSE_SDL = `
  type TestStudent {
    required name: str;
    multi courses: TestCourse;
  };
  type TestCourse {
    required title: str;
    multi students: TestStudent;
  };
`;

const STUDENT_TABLE = "test_student";
const COURSE_TABLE = "test_course";
const JUNCTION_TABLE = "test_student_courses";

Deno.test({
  name:
    "PG Junction: SDL with reciprocal multi-links creates junction table and supports many-to-many queries",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);

    try {
      await cleanup(pool, [
        JUNCTION_TABLE,
        "test_course_students",
        STUDENT_TABLE,
        COURSE_TABLE,
      ]);

      const { schema } = await applySchema(pool, STUDENT_COURSE_SDL);

      // Verify junction table was created
      const tableCheck = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = '${JUNCTION_TABLE}'`,
      );
      assertEquals(
        tableCheck.rows.length,
        1,
        `Junction table ${JUNCTION_TABLE} should exist`,
      );

      // Insert test data
      const adaId = crypto.randomUUID();
      const billieId = crypto.randomUUID();
      const mathId = crypto.randomUUID();
      const scienceId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO ${STUDENT_TABLE} (id, name) VALUES ($1, 'Ada'), ($2, 'Billie')`,
        [adaId, billieId],
      );
      await pool.query(
        `INSERT INTO ${COURSE_TABLE} (id, title) VALUES ($1, 'Math'), ($2, 'Science')`,
        [mathId, scienceId],
      );

      // Link: Ada -> Math, Science; Billie -> Math
      await pool.query(
        `INSERT INTO ${JUNCTION_TABLE} (source_id, target_id) VALUES ($1, $2), ($1, $3), ($4, $2)`,
        [adaId, mathId, scienceId, billieId],
      );

      // Compile and run: SELECT TestStudent { name, courses: { title } }
      // filtering for Ada
      const sql = compileEdgeQL(
        `SELECT TestStudent { name, courses: { title } } FILTER .name = "Ada"`,
        schema,
      );

      const result = await pool.query(sql);
      assertEquals(result.rows.length, 1, "Should return 1 row for Ada");

      const row = result.rows[0];
      const data = typeof row.jsonb_build_object === "string"
        ? JSON.parse(row.jsonb_build_object)
        : row.jsonb_build_object;

      assertEquals(data.name, "Ada");
      assertExists(data.courses, "Should have courses field");

      const courseTitles = data.courses
        .map((c: { title: string }) => c.title)
        .sort();
      assertEquals(courseTitles, ["Math", "Science"]);
    } finally {
      await cleanup(pool, [
        JUNCTION_TABLE,
        "test_course_students",
        STUDENT_TABLE,
        COURSE_TABLE,
      ]);
      await pool.close();
    }
  },
});

Deno.test({
  name:
    "PG Junction: Reverse direction query through junction table returns correct results",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);

    try {
      await cleanup(pool, [
        JUNCTION_TABLE,
        "test_course_students",
        STUDENT_TABLE,
        COURSE_TABLE,
      ]);

      const { schema } = await applySchema(pool, STUDENT_COURSE_SDL);

      // Insert test data
      const adaId = crypto.randomUUID();
      const billieId = crypto.randomUUID();
      const mathId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO ${STUDENT_TABLE} (id, name) VALUES ($1, 'Ada'), ($2, 'Billie')`,
        [adaId, billieId],
      );
      await pool.query(
        `INSERT INTO ${COURSE_TABLE} (id, title) VALUES ($1, 'Math')`,
        [mathId],
      );

      // Link both students to Math — use the course's junction table
      // The SchemaManager assigns test_course_students for TestCourse.students
      const courseJunction = "test_course_students";
      const courseJunctionCheck = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = '${courseJunction}'`,
      );

      // If the deduplication suppressed the second junction table, use the
      // first one with swapped columns
      if (courseJunctionCheck.rows.length === 0) {
        // Reciprocal uses test_student_courses with swapped columns
        await pool.query(
          `INSERT INTO ${JUNCTION_TABLE} (source_id, target_id) VALUES ($1, $2), ($3, $2)`,
          [adaId, mathId, billieId],
        );
      } else {
        await pool.query(
          `INSERT INTO ${courseJunction} (source_id, target_id) VALUES ($1, $2), ($1, $3)`,
          [mathId, adaId, billieId],
        );
      }

      // Query from Course side: SELECT TestCourse { title, students: { name } }
      const sql = compileEdgeQL(
        `SELECT TestCourse { title, students: { name } } FILTER .title = "Math"`,
        schema,
      );

      const result = await pool.query(sql);
      assertEquals(result.rows.length, 1, "Should return 1 row for Math");

      const row = result.rows[0];
      const data = typeof row.jsonb_build_object === "string"
        ? JSON.parse(row.jsonb_build_object)
        : row.jsonb_build_object;

      assertEquals(data.title, "Math");
      assertExists(data.students, "Should have students field");

      const studentNames = data.students
        .map((s: { name: string }) => s.name)
        .sort();
      assertEquals(studentNames, ["Ada", "Billie"]);
    } finally {
      await cleanup(pool, [
        JUNCTION_TABLE,
        "test_course_students",
        STUDENT_TABLE,
        COURSE_TABLE,
      ]);
      await pool.close();
    }
  },
});

Deno.test({
  name:
    "PG Junction: One-to-many with backlink still works after junction table changes",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);

    const AUTHOR_TABLE = "test_author";
    const ARTICLE_TABLE = "test_article";

    const SDL = `
      type TestAuthor {
        required name: str;
        multi articles: TestArticle;
      };
      type TestArticle {
        required title: str;
        required author: TestAuthor;
      };
    `;

    try {
      await cleanup(pool, [ARTICLE_TABLE, AUTHOR_TABLE]);

      const { schema } = await applySchema(pool, SDL);

      // Insert test data
      const authorId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO ${AUTHOR_TABLE} (id, name) VALUES ($1, 'Ada')`,
        [authorId],
      );
      await pool.query(
        `INSERT INTO ${ARTICLE_TABLE} (id, title, author_id) VALUES ($1, 'Paper A', $3), ($2, 'Paper B', $3)`,
        [crypto.randomUUID(), crypto.randomUUID(), authorId],
      );

      // One-to-many via backlink (not junction table)
      const sql = compileEdgeQL(
        `SELECT TestAuthor { name, articles: { title } } FILTER .name = "Ada"`,
        schema,
      );

      const result = await pool.query(sql);
      assertEquals(result.rows.length, 1);

      const row = result.rows[0];
      const data = typeof row.jsonb_build_object === "string"
        ? JSON.parse(row.jsonb_build_object)
        : row.jsonb_build_object;

      assertEquals(data.name, "Ada");
      const titles = data.articles
        .map((a: { title: string }) => a.title)
        .sort();
      assertEquals(titles, ["Paper A", "Paper B"]);
    } finally {
      await cleanup(pool, [ARTICLE_TABLE, AUTHOR_TABLE]);
      await pool.close();
    }
  },
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
        schema,
      );

      await pool.query(sql);

      const verify = await pool.query(
        `SELECT count(*)::int AS cnt FROM ${EMP_TABLE} WHERE name = 'BatchPerson'`,
      );
      assertEquals(
        Number(verify.rows[0].cnt),
        3,
        "Should have 3 batch-inserted rows",
      );
    } finally {
      await cleanup(pool, [EMP_TABLE]);
      await pool.close();
    }
  },
});
