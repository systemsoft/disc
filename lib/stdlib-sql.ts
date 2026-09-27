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

  // disc_access_check(passes, violation) — the access policy check on each
  // object an insert or update writes (compiler/compiler.ts `writeCheck`):
  // TRUE when it passes, else Gel's access policy violation, raised as
  // SQLSTATE 42501 (insufficient_privilege), which aborts the statement.
  `CREATE OR REPLACE FUNCTION disc_access_check(passes boolean, violation text) RETURNS boolean AS $$
     BEGIN
       IF passes IS NOT TRUE THEN
         RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = violation;
       END IF;
       RETURN TRUE;
     END;
   $$ LANGUAGE plpgsql VOLATILE;`,

  // disc_check_constraint(holds, message, detail, constraint_name,
  // table_name) — the CHECK of a type-level `constraint expression on (…)`
  // (migration/ddl.ts `addCheck`): TRUE unless `holds` is FALSE — an empty
  // expression (NULL) passes, as in Gel — else Gel's ConstraintViolationError
  // ("invalid <Type>", or the constraint's errmessage), raised as SQLSTATE
  // 23514 (check_violation) naming the constraint and table. STABLE, not
  // IMMUTABLE, so a constant expression isn't folded (and raised) when the
  // CHECK is created.
  `CREATE OR REPLACE FUNCTION disc_check_constraint(holds boolean, message text, detail text, constraint_name text, table_name text) RETURNS boolean AS $$
     BEGIN
       IF holds IS FALSE THEN
         RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = message, DETAIL = detail, CONSTRAINT = constraint_name, TABLE = table_name;
       END IF;
       RETURN TRUE;
     END;
   $$ LANGUAGE plpgsql STABLE;`,

  // disc_each_holds(vals, condition) — the CHECK of a scalar's `constraint
  // expression on (…)` on an array column (a multi property, or an array of
  // the scalar; migration/differ.ts `arrayExpressionCheck`): FALSE when the
  // boolean `condition` — the constraint compiled with its subject as the
  // parameter `$1`, from the schema, never from a query — is FALSE for an
  // element, bound as `$1`; else TRUE. A CHECK can't hold the subquery that
  // would unnest the array. The condition is row-local (`subjectCheckSql`
  // rejects anything else), so this reads no table. STABLE, not IMMUTABLE,
  // like `disc_check_constraint`.
  `CREATE OR REPLACE FUNCTION disc_each_holds(vals anyarray, condition text) RETURNS boolean AS $$
     DECLARE
       holds boolean;
     BEGIN
       IF cardinality(vals) = 0 THEN
         RETURN TRUE;
       END IF;
       FOR i IN array_lower(vals, 1)..array_upper(vals, 1) LOOP
         EXECUTE 'SELECT ' || condition INTO holds USING vals[i];
         IF holds IS FALSE THEN
           RETURN FALSE;
         END IF;
       END LOOP;
       RETURN TRUE;
     END;
   $$ LANGUAGE plpgsql STABLE STRICT;`,

  // disc_assert_single(value, n) — `assert_single(<set>)` (compiler
  // `assertSingle`): `value`, one of the set's `n` rows, unless there are
  // more than one: Gel's CardinalityViolationError, SQLSTATE 21000
  // (cardinality_violation).
  `CREATE OR REPLACE FUNCTION disc_assert_single(value anyelement, n bigint) RETURNS anyelement AS $$
     BEGIN
       IF n > 1 THEN
         RAISE EXCEPTION USING ERRCODE = 'cardinality_violation', MESSAGE = 'assert_single violation: more than one element returned by an expression';
       END IF;
       RETURN value;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE;`,

  // disc_finite_numeric(value, type_name) — every cast to `decimal` or
  // `bigint` (compiler `finiteNumeric`): the value, unless it is NaN or
  // ±Infinity. PostgreSQL's numeric has them; Gel's decimal and bigint do not
  // (Gel rejects 'NaN' in str_to_decimal and NaN/±Infinity in a float →
  // decimal cast), so they are an InvalidValueError, SQLSTATE 22P02. numeric
  // compares NaN equal to itself, so `IN` finds it. A `std::bigint` must also
  // have no fractional part (Gel's `bigint_t` domain checks `scale(VALUE) =
  // 0`; its `str_to_bigint` rejects '1.5' with this message). The array form
  // checks each element.
  `CREATE OR REPLACE FUNCTION disc_finite_numeric(value numeric, type_name text) RETURNS numeric AS $$
     BEGIN
       IF value IN ('NaN', 'Infinity', '-Infinity') THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_text_representation', MESSAGE = format('invalid value for %s: %L', type_name, value::text);
       END IF;
       IF type_name = 'std::bigint' AND scale(value) <> 0 THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_text_representation', MESSAGE = format('invalid input syntax for type %s: %L', type_name, value::text);
       END IF;
       RETURN value;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_finite_numeric(value numeric[], type_name text) RETURNS numeric[] AS $$
     BEGIN
       PERFORM disc_finite_numeric(e.v, type_name) FROM (SELECT unnest(value) AS v) AS e;
       RETURN value;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  // disc_date_part(func_name, unit, val, units) — `datetime_get`,
  // `duration_get`, `cal::time_get` and `cal::date_get` with a unit that isn't
  // a literal (compiler `compileDatePartGet`, which checks a literal one):
  // PostgreSQL's date_part of `val`, when `unit` is one of `units`, else
  // Gel's invalid unit error (SQLSTATE 22007, InvalidValueError). The
  // `epochseconds`, `midnightseconds` and `totalseconds` units are `epoch`.
  `CREATE OR REPLACE FUNCTION disc_date_part(func_name text, unit text, val anyelement, units text[]) RETURNS double precision AS $$
     BEGIN
       IF unit <> ALL(units) THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format', MESSAGE = format('invalid unit for %s: %L', func_name, unit),
           HINT = format('Supported units: %s.', array_to_string(units, ', '));
       END IF;
       RETURN date_part(CASE WHEN unit IN ('epochseconds', 'midnightseconds', 'totalseconds') THEN 'epoch' ELSE unit END, val);
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  // disc_datetime_sub(a, b) — `datetime - datetime`, a `duration`. PostgreSQL's
  // `timestamptz - timestamptz` moves whole 24 hours into days (`2 days
  // 01:00:00`, ISO `P2DT1H`); a Gel duration holds no days (`PT49H`), so the
  // days are moved back into hours. Both parts of the difference share a sign.
  `CREATE OR REPLACE FUNCTION disc_datetime_sub(a timestamptz, b timestamptz) RETURNS interval AS $$
     SELECT (a - b) + extract(day FROM a - b)::integer * (interval '24 hours' - interval '1 day');
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  // disc_date_duration_text(d) — a `cal::date_duration` (or an array of them)
  // as Gel writes it: ISO 8601, like every interval (connections use
  // `intervalstyle = iso_8601`, lib/database.ts), except zero, which Gel
  // writes `P0D` where PostgreSQL writes `PT0S`. The compiler applies it where
  // a value leaves as text and its type is known (`dateDurationText`).
  `CREATE OR REPLACE FUNCTION disc_date_duration_text(d interval) RETURNS text AS $$
     SELECT CASE WHEN d::text = 'PT0S' THEN 'P0D' ELSE d::text END;
   $$ LANGUAGE SQL IMMUTABLE STRICT SET intervalstyle = 'iso_8601';`,

  `CREATE OR REPLACE FUNCTION disc_date_duration_text(d interval[]) RETURNS text[] AS $$
     SELECT ARRAY(
       SELECT disc_date_duration_text(e.v) FROM (SELECT unnest(d) AS v, generate_subscripts(d, 1) AS ord) AS e ORDER BY e.ord
     );
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  // Per-element checks for `multi` str properties, stored as `text[]`
  // (migration/ddl.ts). A CHECK constraint can't contain a subquery, so the
  // unnest lives in these IMMUTABLE helpers. Each yields NULL for an empty
  // array, which a CHECK treats as passing. Elements come from a
  // `(SELECT unnest(…))` derived table, never `FROM <name>`, per the Gel #8811
  // no-table-reads pin (tests/gel-divergence-pins.test.ts).
  `CREATE OR REPLACE FUNCTION disc_array_max_len(vals text[]) RETURNS integer AS $$
     SELECT max(char_length(e.v)) FROM (SELECT unnest(vals) AS v) AS e;
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_array_min_len(vals text[]) RETURNS integer AS $$
     SELECT min(char_length(e.v)) FROM (SELECT unnest(vals) AS v) AS e;
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_array_all_match(vals text[], pattern text) RETURNS boolean AS $$
     SELECT bool_and(e.v ~ pattern) FROM (SELECT unnest(vals) AS v) AS e;
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  // The finite CHECK of a `multi` bigint or `array<bigint>` column
  // (migration/ddl.ts `finiteCheck`): every element has no fractional part.
  // NaN and ±Infinity have no scale; the CHECK's `&&` rejects those.
  `CREATE OR REPLACE FUNCTION disc_array_integral(vals numeric[]) RETURNS boolean AS $$
     SELECT bool_and(scale(e.v) = 0) FROM (SELECT unnest(vals) AS v) AS e;
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  // `update … set { multi_prop -= values }`: the elements of `vals` not in
  // `removed`, in their original order (every occurrence is removed).
  `CREATE OR REPLACE FUNCTION disc_array_except(vals anyarray, removed anyarray) RETURNS anyarray AS $$
     SELECT ARRAY(
       SELECT e.v FROM (SELECT unnest(vals) AS v, generate_subscripts(vals, 1) AS ord) AS e
       WHERE e.v <> ALL(removed) ORDER BY e.ord
     );
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

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

  // encode(…, 'base64') breaks lines every 76 characters (MIME style); Gel's
  // base64_encode, RFC 4648 and Disc's `bytes` wire format have none.
  // std_base64_decode needs no counterpart: decode() ignores whitespace.
  `CREATE OR REPLACE FUNCTION std_base64_encode(data bytea) RETURNS text AS $$
     SELECT translate(encode(data, 'base64'), E'\\n', '');
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
