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

  // disc_object_cast(id, present, type_name) — `<T><uuid>x` (compiler
  // `objectCast`): the id, unless it is not NULL and names no object of the
  // type (`present` is FALSE): Gel's CardinalityViolationError,
  // "'default::T' with id '…' does not exist", SQLSTATE 21000. The query
  // that finds the object is the caller's (`present`), so this reads no table.
  // (Not `found`: PL/pgSQL's FOUND would shadow it.)
  `CREATE OR REPLACE FUNCTION disc_object_cast(id uuid, present boolean, type_name text) RETURNS uuid AS $$
     BEGIN
       IF id IS NOT NULL AND present IS NOT TRUE THEN
         RAISE EXCEPTION USING ERRCODE = 'cardinality_violation', MESSAGE = format('%L with id %L does not exist', type_name, id::text);
       END IF;
       RETURN id;
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

  // disc_str_to_bigint(val) — a `str` cast to `bigint` (`<bigint>'12'`,
  // `to_bigint('12')`; compiler `compileTypeCast`), as numeric. Text that is
  // no number is Gel's `str_to_bigint` error, which names `std::bigint`
  // (InvalidValueError, SQLSTATE 22P02); PostgreSQL's numeric cast would
  // name `numeric`, Gel's `std::decimal`. `disc_finite_numeric` checks the
  // number.
  `CREATE OR REPLACE FUNCTION disc_str_to_bigint(val text) RETURNS numeric AS $$
     BEGIN
       RETURN val::numeric;
     EXCEPTION WHEN invalid_text_representation THEN
       RAISE EXCEPTION USING ERRCODE = 'invalid_text_representation', MESSAGE = 'invalid input syntax for type std::bigint: ' || quote_literal(val);
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  // disc_str_to_bool(val) — a `str` cast to `bool` (compiler
  // `compileTypeCast`), as Gel's `str_to_bool` reads it: `true` or `false`
  // in any case, blanks around it; PostgreSQL's `t`, `yes`, `1` are not.
  // Anything else is Gel's error (InvalidValueError, SQLSTATE 22P02).
  `CREATE OR REPLACE FUNCTION disc_str_to_bool(val text) RETURNS boolean AS $$
     DECLARE
       m text[] := regexp_match(val, '^\\s*(?:(true)|(false))\\s*$', 'i');
     BEGIN
       IF m IS NULL THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_text_representation', MESSAGE = 'invalid input syntax for type std::bool: ' || quote_literal(val);
       END IF;
       RETURN m[2] IS NULL;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  // disc_datetime_in(val), disc_local_datetime_in(val), disc_local_date_in(val),
  // disc_local_time_in(val) — a `str` cast to `datetime`, `cal::local_datetime`,
  // `cal::local_date` or `cal::local_time` (compiler `compileTypeCast`), as
  // Gel's `datetime_in`, … (edb/pgsql/metaschema.py) read it: only ISO 8601
  // text, a datetime with its time zone and a local one without, so
  // PostgreSQL never guesses a zone. Other text is Gel's error and hint
  // (InvalidValueError, SQLSTATE 22007); text of the form with a field out
  // of range is PostgreSQL's cast error. A local time of hour 24 is out of
  // range, as in Gel.
  `CREATE OR REPLACE FUNCTION disc_datetime_in(val text) RETURNS timestamptz AS $$
     BEGIN
       IF val !~ '^\\s*((\\d{4}-\\d{2}-\\d{2}|\\d{8})[ tT](\\d{2}(:\\d{2}(:\\d{2}(\\.\\d+)?)?)?|\\d{2,6}(\\.\\d+)?)([zZ]|[-+](\\d{2,4}|\\d{2}:\\d{2})))\\s*$' THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format', MESSAGE = 'invalid input syntax for type std::datetime: ' || quote_literal(val),
           HINT = 'Please use ISO8601 format. Example: 2010-12-27T23:59:59-07:00. Alternatively "to_datetime" function provides custom formatting options.';
       END IF;
       RETURN val::timestamptz;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_local_datetime_in(val text) RETURNS timestamp AS $$
     BEGIN
       IF val !~ '^\\s*((\\d{4}-\\d{2}-\\d{2}|\\d{8})[ tT](\\d{2}(:\\d{2}(:\\d{2}(\\.\\d+)?)?)?|\\d{2,6}(\\.\\d+)?))\\s*$' THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format', MESSAGE = 'invalid input syntax for type std::cal::local_datetime: ' || quote_literal(val),
           HINT = 'Please use ISO8601 format. Example 2010-04-18T09:27:00 Alternatively "to_local_datetime" function provides custom formatting options.';
       END IF;
       RETURN val::timestamp;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_local_date_in(val text) RETURNS date AS $$
     BEGIN
       IF val !~ '^\\s*(\\d{4}-\\d{2}-\\d{2}|\\d{8})\\s*$' THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format', MESSAGE = 'invalid input syntax for type std::cal::local_date: ' || quote_literal(val),
           HINT = 'Please use ISO8601 format. Example 2010-04-18 Alternatively "to_local_date" function provides custom formatting options.';
       END IF;
       RETURN val::date;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_local_time_in(val text) RETURNS time AS $$
     DECLARE
       result time;
     BEGIN
       IF val !~ '^\\s*(\\d{2}(:\\d{2}(:\\d{2}(\\.\\d+)?)?)?|\\d{2,6}(\\.\\d+)?)\\s*$' THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format', MESSAGE = 'invalid input syntax for type std::cal::local_time: ' || quote_literal(val),
           HINT = 'Please use ISO8601 format. Examples: 18:43:27 or 18:43 Alternatively "to_local_time" function provides custom formatting options.';
       END IF;
       result := val::time;
       IF date_part('hour', result) = 24 THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format', MESSAGE = 'std::cal::local_time field value out of range: ' || quote_literal(val);
       END IF;
       RETURN result;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  // disc_duration_in(val), disc_date_duration_in(val) — a `str` cast to
  // `duration` or `cal::date_duration` (compiler `compileTypeCast`), as Gel's
  // `duration_in` and `date_duration_in` read it: an interval (PostgreSQL's
  // error when it is none), of no day, month or year units for a duration
  // and none smaller than days for a date duration; else Gel's error and
  // hint (InvalidValueError, SQLSTATE 22007).
  `CREATE OR REPLACE FUNCTION disc_duration_in(val text) RETURNS interval AS $$
     DECLARE
       result interval := val::interval;
     BEGIN
       IF date_part('year', result) <> 0 OR date_part('month', result) <> 0 OR date_part('day', result) <> 0 THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format', MESSAGE = 'invalid input syntax for type std::duration: ' || quote_literal(val),
           HINT = 'Day, month and year units cannot be used for std::duration.';
       END IF;
       RETURN result;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_date_duration_in(val text) RETURNS interval AS $$
     DECLARE
       result interval := val::interval;
     BEGIN
       IF date_part('hour', result) <> 0 OR date_part('minute', result) <> 0 OR date_part('second', result) <> 0 THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format', MESSAGE = 'invalid input syntax for type std::cal::date_duration: ' || quote_literal(val),
           HINT = 'Units smaller than days cannot be used for std::cal::date_duration.';
       END IF;
       RETURN result;
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

  // disc_format_arg(func_name, fmt) — the format argument of `to_str`,
  // `to_datetime`, `to_int64`, … (compiler `compileFormatted`): `fmt`, unless
  // it is empty, which Gel rejects before PostgreSQL sees it
  // (InvalidValueError, SQLSTATE 22023). NULL, an empty set, is NULL: the
  // compiler then falls back to the function's form without a format.
  `CREATE OR REPLACE FUNCTION disc_format_arg(func_name text, fmt text) RETURNS text AS $$
     BEGIN
       IF fmt = '' THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value', MESSAGE = func_name || '(): "fmt" argument must be a non-empty string';
       END IF;
       RETURN fmt;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  // disc_to_str(val, fmt) — `to_str(val, fmt)`: PostgreSQL's to_char, as Gel
  // calls it, in UTC (Gel's server time zone; `TZ` is `UTC`). A local date is
  // formatted as midnight UTC, a local time on today's date, as in Gel.
  `CREATE OR REPLACE FUNCTION disc_to_str(val timestamptz, fmt text) RETURNS text AS $$
     SELECT to_char(val, disc_format_arg('to_str', fmt));
   $$ LANGUAGE SQL IMMUTABLE STRICT SET timezone = 'UTC';`,

  `CREATE OR REPLACE FUNCTION disc_to_str(val timestamp, fmt text) RETURNS text AS $$
     SELECT to_char(val, disc_format_arg('to_str', fmt));
   $$ LANGUAGE SQL IMMUTABLE STRICT SET timezone = 'UTC';`,

  `CREATE OR REPLACE FUNCTION disc_to_str(val date, fmt text) RETURNS text AS $$
     SELECT to_char(val::timestamptz, disc_format_arg('to_str', fmt));
   $$ LANGUAGE SQL IMMUTABLE STRICT SET timezone = 'UTC';`,

  `CREATE OR REPLACE FUNCTION disc_to_str(val time, fmt text) RETURNS text AS $$
     SELECT to_char(date_trunc('day', localtimestamp) + val, disc_format_arg('to_str', fmt));
   $$ LANGUAGE SQL IMMUTABLE STRICT SET timezone = 'UTC';`,

  // A format of calendar fields (`Day`, `Mon`) is PostgreSQL's error for an
  // interval, which Gel words for its type.
  `CREATE OR REPLACE FUNCTION disc_to_str(val interval, fmt text) RETURNS text AS $$
     BEGIN
       RETURN to_char(val, disc_format_arg('to_str', fmt));
     EXCEPTION WHEN invalid_datetime_format THEN
       RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format', MESSAGE = replace(SQLERRM, 'an interval value', 'an std::duration value');
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_to_str(val bigint, fmt text) RETURNS text AS $$
     SELECT to_char(val, disc_format_arg('to_str', fmt));
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_to_str(val double precision, fmt text) RETURNS text AS $$
     SELECT to_char(val, disc_format_arg('to_str', fmt));
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_to_str(val numeric, fmt text) RETURNS text AS $$
     SELECT to_char(val, disc_format_arg('to_str', fmt));
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  // JSON's one format is `pretty`.
  `CREATE OR REPLACE FUNCTION disc_to_str(val jsonb, fmt text) RETURNS text AS $$
     BEGIN
       IF disc_format_arg('to_str', fmt) <> 'pretty' THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value', MESSAGE = 'to_str(): format ''' || fmt || ''' is invalid';
       END IF;
       RETURN jsonb_pretty(val);
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  // disc_to_number(func_name, val, fmt) — `to_int64(val, fmt)`, `to_decimal`,
  // …: PostgreSQL's to_number, which the compiler casts to the type.
  `CREATE OR REPLACE FUNCTION disc_to_number(func_name text, val text, fmt text) RETURNS numeric AS $$
     SELECT to_number(val, disc_format_arg(func_name, fmt));
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  // disc_to_timestamp(func_name, val, fmt, zoned) — `to_datetime(val, fmt)`
  // (zoned) and `cal::to_local_datetime` / `_date` / `_time` (not): Gel's
  // to_timestamp in UTC. A datetime's format must have a time zone (`TZH`
  // outside a quoted part), a local one must have none; and so must the
  // input: parsed again in another time zone, a value that names its zone is
  // the same instant. (Gel's `_to_timestamptz_check`; InvalidValueError,
  // SQLSTATE 22007.) The result must be in years 1 to 9999 (UTC), as Gel's
  // `timestamptz_t` is, which one parsed without a year (1 BC) is not
  // (InvalidValueError, SQLSTATE 22008). The time zone setting is the
  // function's own.
  `CREATE OR REPLACE FUNCTION disc_to_timestamp(func_name text, val text, fmt text, zoned boolean) RETURNS timestamptz AS $$
     DECLARE
       result timestamptz;
       shifted timestamptz;
     BEGIN
       PERFORM disc_format_arg(func_name, fmt);
       IF zoned AND fmt !~ '^(("([^"\\\\]|\\\\.)*")|([^"]+))*(TZH).*$' THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format', MESSAGE = 'missing required time zone in format: ' || quote_literal(fmt),
           HINT = 'Use one or both of the following: ''TZH'', ''TZM''';
       END IF;
       IF NOT zoned AND fmt ~ '^(("([^"\\\\]|\\\\.)*")|([^"]+))*(TZH|TZM).*$' THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format', MESSAGE = 'unexpected time zone in format: ' || quote_literal(fmt);
       END IF;
       result := to_timestamp(val, fmt);
       PERFORM set_config('TimeZone', 'America/Toronto', true);
       shifted := to_timestamp(val, fmt);
       PERFORM set_config('TimeZone', 'UTC', true);
       IF (result = shifted) <> zoned THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_datetime_format',
           MESSAGE = CASE WHEN zoned THEN 'missing required' ELSE 'unexpected' END || ' time zone in input ' || quote_literal(val);
       END IF;
       IF extract(year FROM result) NOT BETWEEN 1 AND 9999 THEN
         RAISE EXCEPTION USING ERRCODE = 'datetime_field_overflow', MESSAGE = '''std::datetime'' value out of range';
       END IF;
       RETURN result;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT SET timezone = 'UTC';`,

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

  // disc_index(val, idx) — `val[idx]` of an array, a `str` or `bytes`
  // (compiler `compileIndexExpression`): the element (a character, a byte) at
  // Gel's 0-based `idx`, a negative one counting from the end, else Gel's
  // out of bounds error, raised as SQLSTATE 2202E (array_subscript_error, an
  // InvalidValueError). The jsonb form is an array of tuples, which Disc
  // holds as a jsonb array. `array_get` answers nothing instead; it does not
  // use these.
  `CREATE OR REPLACE FUNCTION disc_index(val anyarray, idx bigint) RETURNS anyelement AS $$
     DECLARE
       n bigint := coalesce(array_length(val, 1), 0);
       i bigint := CASE WHEN idx < 0 THEN idx + n ELSE idx END;
     BEGIN
       IF i < 0 OR i >= n THEN
         RAISE EXCEPTION USING ERRCODE = 'array_subscript_error', MESSAGE = format('array index %s is out of bounds', idx);
       END IF;
       RETURN val[(i + 1)::integer];
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_index(val jsonb, idx bigint) RETURNS jsonb AS $$
     DECLARE
       n bigint := jsonb_array_length(val);
       i bigint := CASE WHEN idx < 0 THEN idx + n ELSE idx END;
     BEGIN
       IF i < 0 OR i >= n THEN
         RAISE EXCEPTION USING ERRCODE = 'array_subscript_error', MESSAGE = format('array index %s is out of bounds', idx);
       END IF;
       RETURN val -> i::integer;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_index(val text, idx bigint) RETURNS text AS $$
     DECLARE
       n bigint := char_length(val);
       i bigint := CASE WHEN idx < 0 THEN idx + n ELSE idx END;
     BEGIN
       IF i < 0 OR i >= n THEN
         RAISE EXCEPTION USING ERRCODE = 'array_subscript_error', MESSAGE = format('string index %s is out of bounds', idx);
       END IF;
       RETURN substr(val, (i + 1)::integer, 1);
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_index(val bytea, idx bigint) RETURNS bytea AS $$
     DECLARE
       n bigint := length(val);
       i bigint := CASE WHEN idx < 0 THEN idx + n ELSE idx END;
     BEGIN
       IF i < 0 OR i >= n THEN
         RAISE EXCEPTION USING ERRCODE = 'array_subscript_error', MESSAGE = format('byte string index %s is out of bounds', idx);
       END IF;
       RETURN substr(val, (i + 1)::integer, 1);
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  // disc_json_index(val, idx) — `val[idx]` of a json (compiler
  // `compileIndexExpression`): an array's element or a string's character
  // (as a json string) at Gel's 0-based `idx`, a negative one counting from
  // the end, or an object's value at key `idx`; else Gel's errors, "JSON
  // index 5 is out of bounds", "JSON index 'missing' is out of bounds",
  // "cannot index JSON number", raised in SQLSTATE class 22 (an
  // InvalidValueError). `json_get` answers nothing instead; it does not use
  // these.
  `CREATE OR REPLACE FUNCTION disc_json_index(val jsonb, idx bigint) RETURNS jsonb AS $$
     DECLARE
       kind text := jsonb_typeof(val);
       n bigint;
       i bigint;
     BEGIN
       IF kind = 'object' THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value', MESSAGE = 'cannot index JSON object by bigint';
       ELSIF kind NOT IN ('array', 'string') THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value', MESSAGE = format('cannot index JSON %s', kind),
           HINT = 'Retrieving an element by an integer index is only available for JSON arrays and strings.';
       END IF;
       n := CASE WHEN kind = 'array' THEN jsonb_array_length(val) ELSE char_length(val #>> '{}') END;
       i := CASE WHEN idx < 0 THEN idx + n ELSE idx END;
       IF i < 0 OR i >= n THEN
         RAISE EXCEPTION USING ERRCODE = 'array_subscript_error', MESSAGE = format('JSON index %s is out of bounds', idx);
       END IF;
       IF kind = 'array' THEN
         RETURN val -> i::integer;
       END IF;
       RETURN to_jsonb(substr(val #>> '{}', (i + 1)::integer, 1));
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_json_index(val jsonb, idx text) RETURNS jsonb AS $$
     DECLARE
       kind text := jsonb_typeof(val);
     BEGIN
       IF kind = 'array' THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value', MESSAGE = 'cannot index JSON array by text';
       ELSIF kind <> 'object' THEN
         RAISE EXCEPTION USING ERRCODE = 'invalid_parameter_value', MESSAGE = format('cannot index JSON %s', kind),
           HINT = 'Retrieving an element by a string index is only available for JSON objects.';
       ELSIF (val -> idx) IS NULL THEN
         RAISE EXCEPTION USING ERRCODE = 'array_subscript_error', MESSAGE = format('JSON index %s is out of bounds', quote_literal(idx));
       END IF;
       RETURN val -> idx;
     END;
   $$ LANGUAGE plpgsql IMMUTABLE STRICT;`,

  // disc_slice(val, start_at[, end_at]) — `val[start_at:end_at]` of an array,
  // a `str` or `bytes` (compiler `compileSliceExpression`): the elements from
  // Gel's 0-based `start_at` up to, not including, `end_at` (the end when
  // omitted), a negative bound counting from the end, a bound past either end
  // clamped to it (`disc_slice_bound`, a PostgreSQL position before the
  // element). An empty bound is an empty slice (STRICT).
  `CREATE OR REPLACE FUNCTION disc_slice_bound(bound bigint, n bigint) RETURNS integer AS $$
     SELECT greatest(0, least(n, CASE WHEN bound < 0 THEN bound + n ELSE bound END))::integer;
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_slice(val anyarray, start_at bigint, end_at bigint) RETURNS anyarray AS $$
     SELECT val[disc_slice_bound(start_at, coalesce(array_length(val, 1), 0)) + 1 : disc_slice_bound(end_at, coalesce(array_length(val, 1), 0))];
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_slice(val anyarray, start_at bigint) RETURNS anyarray AS $$
     SELECT disc_slice(val, start_at, coalesce(array_length(val, 1), 0));
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_slice(val text, start_at bigint, end_at bigint) RETURNS text AS $$
     SELECT substr(val, disc_slice_bound(start_at, char_length(val)) + 1,
       greatest(0, disc_slice_bound(end_at, char_length(val)) - disc_slice_bound(start_at, char_length(val))));
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_slice(val text, start_at bigint) RETURNS text AS $$
     SELECT disc_slice(val, start_at, char_length(val));
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_slice(val bytea, start_at bigint, end_at bigint) RETURNS bytea AS $$
     SELECT substr(val, disc_slice_bound(start_at, length(val)) + 1,
       greatest(0, disc_slice_bound(end_at, length(val)) - disc_slice_bound(start_at, length(val))));
   $$ LANGUAGE SQL IMMUTABLE STRICT;`,

  `CREATE OR REPLACE FUNCTION disc_slice(val bytea, start_at bigint) RETURNS bytea AS $$
     SELECT disc_slice(val, start_at, length(val));
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
