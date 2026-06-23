/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Disc stdlib — SQL bootstrap for EdgeQL `std::*` functions that don't
 * map 1-to-1 onto a PostgreSQL built-in. (gh/geldata#5065)
 *
 * Run once at server boot via `bootstrapStdlib()`. All statements are
 * idempotent (CREATE OR REPLACE / CREATE EXTENSION IF NOT EXISTS) so
 * re-runs are no-ops.
 *
 * The wrappers exist because:
 *   - `md5(bytea)` returns `text` in PG, but we want `bytes` in EdgeQL,
 *     so we re-encode through `decode(..., 'hex')`.
 *   - `encode/decode` take positional format args; wrapping into
 *     `std_hex_*` / `std_base64_*` names lets the compiler emit a
 *     plain function call instead of a multi-arg expression.
 *   - `digest(bytea, 'sha1')` is pgcrypto-only; the wrapper hides the
 *     algorithm-as-string detail behind a typed function.
 *
 * SHA-256 and SHA-512 use PG built-ins (`sha256(bytea)` / `sha512(bytea)`,
 * available since PG 11) — no wrappers needed. HMAC uses pgcrypto's
 * `hmac()` directly — same.
 */

import type { ConnectionPool } from "./connection-pool.ts";
import { getLogger } from "./logger.ts";

const log = getLogger("stdlib");

const STDLIB_SQL = [
  // pgcrypto powers std::sha1 + std::hmac. SHA-256/512 don't need it
  // (PG core), but enabling pgcrypto unconditionally keeps the bootstrap
  // simple and matches operator expectations from older PG versions.
  "CREATE EXTENSION IF NOT EXISTS pgcrypto;",

  // disc_uuidv7() — time-ordered UUIDv7 (RFC 9562) used as the default for
  // every object's primary key. Disc's deliberate divergence from Gel's
  // random v4 ids: the 48-bit millisecond timestamp prefix gives sequential
  // index inserts (no B-tree page-split churn) and a free chronological sort.
  //
  // Built on pgcrypto's gen_random_bytes so it works identically on PG 16/17/18
  // and external servers, rather than depending on PG 18's native uuidv7().
  // Bytes are set explicitly (0-indexed) to keep the version/variant nibbles
  // auditable: byte 6 high nibble = 0x7 (version), byte 8 high bits = 0b10
  // (variant); all other bits stay random.
  `CREATE OR REPLACE FUNCTION disc_uuidv7() RETURNS uuid AS $$
     DECLARE
       ts_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
       v bytea := gen_random_bytes(16);
     BEGIN
       v := set_byte(v, 0, ((ts_ms >> 40) & 255)::int);
       v := set_byte(v, 1, ((ts_ms >> 32) & 255)::int);
       v := set_byte(v, 2, ((ts_ms >> 24) & 255)::int);
       v := set_byte(v, 3, ((ts_ms >> 16) & 255)::int);
       v := set_byte(v, 4, ((ts_ms >> 8) & 255)::int);
       v := set_byte(v, 5, (ts_ms & 255)::int);
       v := set_byte(v, 6, ((get_byte(v, 6) & 15) | 112));
       v := set_byte(v, 8, ((get_byte(v, 8) & 63) | 128));
       RETURN encode(v, 'hex')::uuid;
     END;
   $$ LANGUAGE plpgsql VOLATILE;`,

  `CREATE OR REPLACE FUNCTION std_md5(msg bytea) RETURNS bytea AS $$
     SELECT decode(md5(msg), 'hex');
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  // pgcrypto: digest(data, type)
  `CREATE OR REPLACE FUNCTION std_sha1(msg bytea) RETURNS bytea AS $$
     SELECT digest(msg, 'sha1');
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION std_hex_encode(data bytea) RETURNS text AS $$
     SELECT encode(data, 'hex');
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION std_hex_decode(data text) RETURNS bytea AS $$
     SELECT decode(data, 'hex');
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION std_base64_encode(data bytea) RETURNS text AS $$
     SELECT encode(data, 'base64');
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION std_base64_decode(data text) RETURNS bytea AS $$
     SELECT decode(data, 'base64');
   $$ LANGUAGE SQL IMMUTABLE STRICT;`
];

/**
 * Run the stdlib SQL bootstrap against the given pool. Logs at warn
 * level on per-statement failure but continues — pgcrypto absence
 * (rare; pgcrypto ships with every supported PG distribution) shouldn't
 * prevent server boot, since users may not need crypto features.
 */
export async function bootstrapStdlib(pool: ConnectionPool): Promise<void> {
  for (const stmt of STDLIB_SQL) {
    try {
      await pool.execute(stmt);
    } catch (err) {
      log.warn("stdlib bootstrap statement failed", {
        error: err instanceof Error ? err.message : String(err),
        statement: stmt.split("\n")[0].slice(0, 80)
      });
    }
  }
}
