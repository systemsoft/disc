/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Runtime tests for the stdlib SQL bootstrap (gh/geldata#5065).
 *
 * Requires PG. Verifies that bootstrapStdlib() installs pgcrypto and
 * the std_* wrapper functions, and that those wrappers compute correct
 * hash/encoding output against well-known vectors.
 */

import { assertEquals } from "@std/assert";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "./connection-pool.ts";
import { bootstrapStdlib } from "./stdlib-sql.ts";

const RUN_PG = canRunPgTests();

async function withPool<T>(
  fn: (pool: ConnectionPool) => Promise<T>
): Promise<T> {
  const dsn = await getTestDsn();
  const pool = new ConnectionPool({ connectionString: dsn });
  await pool.initialize();
  try {
    await bootstrapStdlib(pool);
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

Deno.test({
  name: "stdlib bootstrap installs pgcrypto",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      const result = await pool.query(
        `SELECT 1 AS ok FROM pg_extension WHERE extname = 'pgcrypto'`
      );
      assertEquals(result.rows.length, 1);
    })
});

Deno.test({
  name: "std_md5 returns correct MD5 of 'hello' (well-known: 5d41402abc4b2a76b9719d911017c592)",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      const result = await pool.query(
        `SELECT encode(std_md5('hello'::bytea), 'hex') AS h`
      );
      assertEquals(result.rows[0].h, "5d41402abc4b2a76b9719d911017c592");
    })
});

Deno.test({
  name: "std_sha1 returns correct SHA-1 of 'hello' (aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d)",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      const result = await pool.query(
        `SELECT encode(std_sha1('hello'::bytea), 'hex') AS h`
      );
      assertEquals(
        result.rows[0].h,
        "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"
      );
    })
});

Deno.test({
  name: "PG built-in sha256 returns correct SHA-256 of 'hello'",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      const result = await pool.query(
        `SELECT encode(sha256('hello'::bytea), 'hex') AS h`
      );
      assertEquals(
        result.rows[0].h,
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
      );
    })
});

Deno.test({
  name: "pgcrypto hmac with sha256 — RFC 4231 test case 1",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      // RFC 4231 §4.2: key=20 bytes of 0x0b, data="Hi There", algo=sha256
      // Expected: b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
      const result = await pool.query(
        `SELECT encode(
           hmac('Hi There'::bytea, decode(repeat('0b', 20), 'hex'), 'sha256'),
           'hex'
         ) AS h`
      );
      assertEquals(
        result.rows[0].h,
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
      );
    })
});

Deno.test({
  name: "std_hex_encode + std_hex_decode roundtrip 'hello'",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      const result = await pool.query(
        `SELECT std_hex_encode('hello'::bytea) AS hex,
                convert_from(std_hex_decode('68656c6c6f'), 'UTF8') AS roundtrip`
      );
      assertEquals(result.rows[0].hex, "68656c6c6f");
      assertEquals(result.rows[0].roundtrip, "hello");
    })
});

Deno.test({
  name: "std_base64_encode + std_base64_decode roundtrip 'hello'",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      const result = await pool.query(
        `SELECT std_base64_encode('hello'::bytea) AS b64,
                convert_from(std_base64_decode('aGVsbG8='), 'UTF8') AS roundtrip`
      );
      assertEquals(result.rows[0].b64, "aGVsbG8=");
      assertEquals(result.rows[0].roundtrip, "hello");
    })
});

Deno.test({
  name: "bootstrapStdlib is idempotent (re-run is a no-op)",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      // withPool already ran bootstrapStdlib once; run twice more.
      await bootstrapStdlib(pool);
      await bootstrapStdlib(pool);
      const result = await pool.query(
        `SELECT encode(std_md5('hello'::bytea), 'hex') AS h`
      );
      assertEquals(result.rows[0].h, "5d41402abc4b2a76b9719d911017c592");
    })
});
