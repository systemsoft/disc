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
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,
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
        statement: stmt.split("\n")[0].slice(0, 80),
      });
    }
  }
}
