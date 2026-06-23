# Built-in Functions Reference

Disc provides a comprehensive standard library of built-in functions available in EdgeQL queries. Each function compiles to its PostgreSQL equivalent at query time.

This reference documents every function registered in the Disc compiler. Functions are organized by category.

**See also:** [EdgeQL](edgeql.md) | [Schema](schema.md) | [CLI](cli.md)

---

## String Functions

### `len`

Returns the length of a string.

```
len(val: str) -> int64
```

**Example:**

```edgeql
select len('hello');
```

**SQL equivalent:** `LENGTH('hello')`

---

### `str_lower`

Converts a string to lowercase.

```
str_lower(val: str) -> str
```

**Example:**

```edgeql
select str_lower('HELLO WORLD');
# => 'hello world'
```

**SQL equivalent:** `LOWER('HELLO WORLD')`

---

### `str_upper`

Converts a string to uppercase.

```
str_upper(val: str) -> str
```

**Example:**

```edgeql
select str_upper('hello world');
# => 'HELLO WORLD'
```

**SQL equivalent:** `UPPER('hello world')`

---

### `str_title`

Converts a string to title case (capitalizes the first letter of each word).

```
str_title(val: str) -> str
```

**Example:**

```edgeql
select str_title('hello world');
# => 'Hello World'
```

**SQL equivalent:** `INITCAP('hello world')`

---

### `str_trim`

Removes leading and trailing whitespace from a string.

```
str_trim(val: str) -> str
```

**Example:**

```edgeql
select str_trim('  hello  ');
# => 'hello'
```

**SQL equivalent:** `TRIM('  hello  ')`

---

### `str_ltrim`

Removes leading whitespace from a string.

```
str_ltrim(val: str) -> str
```

**Example:**

```edgeql
select str_ltrim('  hello');
# => 'hello'
```

**SQL equivalent:** `LTRIM('  hello')`

---

### `str_rtrim`

Removes trailing whitespace from a string.

```
str_rtrim(val: str) -> str
```

**Example:**

```edgeql
select str_rtrim('hello  ');
# => 'hello'
```

**SQL equivalent:** `RTRIM('hello  ')`

---

### `str_repeat`

Repeats a string a given number of times.

```
str_repeat(val: str, n: int64) -> str
```

**Example:**

```edgeql
select str_repeat('ab', 3);
# => 'ababab'
```

**SQL equivalent:** `REPEAT('ab', 3)`

---

### `str_replace`

Replaces all occurrences of a substring with another string.

```
str_replace(val: str, old: str, new: str) -> str
```

**Example:**

```edgeql
select str_replace('hello world', 'world', 'disc');
# => 'hello disc'
```

**SQL equivalent:** `REPLACE('hello world', 'world', 'disc')`

---

### `str_split`

Splits a string by a delimiter and returns an array.

```
str_split(val: str, delimiter: str) -> array<str>
```

**Example:**

```edgeql
select str_split('a,b,c', ',');
# => ['a', 'b', 'c']
```

**SQL equivalent:** `STRING_TO_ARRAY('a,b,c', ',')`

---

### `str_starts_with`

Returns true if the string starts with the given prefix.

```
str_starts_with(val: str, prefix: str) -> bool
```

**Example:**

```edgeql
select str_starts_with('hello', 'he');
# => true
```

**SQL equivalent:** `STARTS_WITH('hello', 'he')`

---

### `str_ends_with`

Returns true if the string ends with the given suffix.

```
str_ends_with(val: str, suffix: str) -> bool
```

**Example:**

```edgeql
select str_ends_with('hello', 'lo');
# => true
```

**SQL equivalent:** `RIGHT('hello', LENGTH('lo')) = 'lo'`

---

### `str_pad_start`

Pads a string on the left to a specified length. Uses spaces by default, or a custom fill character.

```
str_pad_start(val: str, n: int64, fill?: str) -> str
```

**Example:**

```edgeql
select str_pad_start('42', 5, '0');
# => '00042'

select str_pad_start('hi', 6);
# => '    hi'
```

**SQL equivalent:** `LPAD('42', 5, '0')`

---

### `str_pad_end`

Pads a string on the right to a specified length. Uses spaces by default, or a custom fill character.

```
str_pad_end(val: str, n: int64, fill?: str) -> str
```

**Example:**

```edgeql
select str_pad_end('hi', 6, '.');
# => 'hi....'
```

**SQL equivalent:** `RPAD('hi', 6, '.')`

---

### `contains`

Returns true if the haystack string contains the needle substring.

This function is overloaded -- when used with range arguments, it checks whether a range contains an element (see [Range Functions](#range-functions)).

```
contains(haystack: str, needle: str) -> bool
```

**Example:**

```edgeql
select contains('hello world', 'world');
# => true

select contains('hello world', 'xyz');
# => false
```

**SQL equivalent:** `STRPOS('hello world', 'world') > 0`

---

### `find`

Returns the 0-based index of the first occurrence of needle in haystack. Returns -1 if not found.

```
find(haystack: str, needle: str) -> int64
```

**Example:**

```edgeql
select find('hello world', 'world');
# => 6

select find('hello', 'xyz');
# => -1
```

**SQL equivalent:** `STRPOS('hello world', 'world') - 1`

Note: PostgreSQL’s `STRPOS` is 1-indexed and returns 0 when not found. Disc adjusts the result to match EdgeQL’s 0-indexed convention.

---

## Regex Functions

### `re_match`

Returns the first match of a regular expression pattern against a string. Returns an array of matched groups.

Note: Argument order in EdgeQL is `(pattern, string)`, but this compiles to PostgreSQL’s `REGEXP_MATCH(string, pattern)` with arguments swapped.

```
re_match(pattern: str, val: str) -> array<str>
```

**Example:**

```edgeql
select re_match('^[a-z]+$', 'hello');
# => ['hello']

select re_match('(\w+)@(\w+)', 'user@host');
# => ['user@host', 'user', 'host']
```

**SQL equivalent:** `REGEXP_MATCH('hello', '^[a-z]+$')`

---

### `re_match_all`

Returns all matches of a regular expression pattern against a string. Each match is an array of groups.

```
re_match_all(pattern: str, val: str) -> array<array<str>>
```

**Example:**

```edgeql
select re_match_all('[0-9]+', 'a1b2c3');
# => [['1'], ['2'], ['3']]
```

**SQL equivalent:** `REGEXP_MATCHES('a1b2c3', '[0-9]+', 'g')`

---

### `re_replace`

Replaces occurrences of a regex pattern with a substitution string.

Note: Argument order in EdgeQL is `(pattern, sub, string)`, but this compiles to PostgreSQL’s `REGEXP_REPLACE(string, pattern, sub)` with arguments reordered.

```
re_replace(pattern: str, sub: str, val: str) -> str
```

**Example:**

```edgeql
select re_replace('[0-9]', 'X', 'a1b2');
# => 'aXbX'
```

**SQL equivalent:** `REGEXP_REPLACE('a1b2', '[0-9]', 'X')`

---

### `re_test`

Returns true if the string matches the regular expression pattern.

```
re_test(pattern: str, val: str) -> bool
```

**Example:**

```edgeql
select re_test('^[a-z]+$', 'hello');
# => true

select re_test('^[0-9]+$', 'hello');
# => false
```

**SQL equivalent:** `'hello' ~ '^[a-z]+$'`

---

## Math Functions

### `random`

Returns a pseudo-random `float64` in the range `0.0 <= x < 1.0`. Volatile — a new value every call.

```
random() -> float64
```

**Example:**

```edgeql
# random row ordering
select User { name } order by random() limit 1;
```

**SQL equivalent:** `RANDOM()`

---

### `math_abs`

Returns the absolute value of a number.

```
math_abs(val: anyreal) -> anyreal
```

**Example:**

```edgeql
select math_abs(-42);
# => 42

select math_abs(-3.14);
# => 3.14
```

**SQL equivalent:** `ABS(-42)`

---

### `math_ceil`

Returns the smallest integer greater than or equal to the given value.

```
math_ceil(val: anyreal) -> float64
```

**Example:**

```edgeql
select math_ceil(3.2);
# => 4.0

select math_ceil(-1.5);
# => -1.0
```

**SQL equivalent:** `CEIL(3.2)`

---

### `math_floor`

Returns the largest integer less than or equal to the given value.

```
math_floor(val: anyreal) -> float64
```

**Example:**

```edgeql
select math_floor(3.8);
# => 3.0

select math_floor(-1.2);
# => -2.0
```

**SQL equivalent:** `FLOOR(3.8)`

---

### `round`

Rounds a number to the nearest integer.

```
round(val: anyreal) -> float64
```

**Example:**

```edgeql
select round(3.5);
# => 4.0

select round(3.4);
# => 3.0
```

**SQL equivalent:** `ROUND(3.5)`

---

### `math_sqrt`

Returns the square root of a number.

```
math_sqrt(val: anyreal) -> float64
```

**Example:**

```edgeql
select math_sqrt(16);
# => 4.0
```

Can also be invoked with the `math::` namespace prefix:

```edgeql
select math::sqrt(16);
```

**SQL equivalent:** `SQRT(16)`

---

### `math_pow`

Raises a base to the given exponent.

```
math_pow(base: anyreal, exp: anyreal) -> float64
```

**Example:**

```edgeql
select math::pow(2, 10);
# => 1024.0
```

**SQL equivalent:** `POWER(2, 10)`

---

### `math_power`

Alias for `math_pow`. Raises a base to the given exponent.

```
math_power(base: anyreal, exp: anyreal) -> float64
```

**Example:**

```edgeql
select math_power(3, 3);
# => 27.0
```

**SQL equivalent:** `POWER(3, 3)`

---

### `math_log`

Returns the logarithm of a value with the specified base.

```
math_log(base: anyreal, val: anyreal) -> float64
```

**Example:**

```edgeql
select math::log(10, 100);
# => 2.0
```

**SQL equivalent:** `LOG(10, 100)`

---

### `math_ln`

Returns the natural logarithm (base e) of a value.

```
math_ln(val: anyreal) -> float64
```

**Example:**

```edgeql
select math::ln(2.718);
# => ~1.0
```

**SQL equivalent:** `LN(2.718)`

---

### `math_log10`

Returns the base-10 logarithm of a value.

```
math_log10(val: anyreal) -> float64
```

**Example:**

```edgeql
select math_log10(100);
# => 2.0
```

**SQL equivalent:** `LOG(10, val)` (computed via PostgreSQL’s `LOG` function with base 10)

---

### `math_log2`

Returns the base-2 logarithm of a value.

```
math_log2(val: anyreal) -> float64
```

**Example:**

```edgeql
select math_log2(8);
# => 3.0
```

**SQL equivalent:** `LOG(2, val)` (computed via PostgreSQL’s `LOG` function with base 2)

---

### `math_pi`

Returns the value of pi.

```
math_pi() -> float64
```

**Example:**

```edgeql
select math::pi();
# => 3.141592653589793
```

**SQL equivalent:** `PI()`

---

### `math_e`

Returns the value of Euler’s number (e).

```
math_e() -> float64
```

**Example:**

```edgeql
select math::e();
# => 2.718281828459045
```

**SQL equivalent:** `EXP(1)`

---

### `math_mean`

Returns the arithmetic mean (average) of a set of values. This is an aggregate function and can also be used as a window function.

```
math_mean(expr: anyreal) -> float64
```

**Example:**

```edgeql
select math_mean(User.age);
```

**SQL equivalent:** `AVG(...)` (same as `avg`)

---

## Aggregate Functions

Aggregate functions operate on sets of values and return a single result. All aggregate functions listed here can also be used as window functions with an `OVER` clause.

### `count`

Returns the number of elements in a set.

```
count(expr: any) -> int64
```

**Example:**

```edgeql
select count(User);

select count(User filter .active = true);
```

**SQL equivalent:** `COUNT(...)`

---

### `sum`

Returns the sum of a set of numeric values.

```
sum(expr: anyreal) -> int64
```

**Example:**

```edgeql
select sum(Order.total);
```

**SQL equivalent:** `SUM(...)`

---

### `min`

Returns the minimum value in a set.

```
min(expr: any) -> int64
```

**Example:**

```edgeql
select min(Product.price);
```

**SQL equivalent:** `MIN(...)`

---

### `max`

Returns the maximum value in a set.

```
max(expr: any) -> int64
```

**Example:**

```edgeql
select max(Product.price);
```

**SQL equivalent:** `MAX(...)`

---

### `avg`

Returns the arithmetic mean of a set of numeric values.

```
avg(expr: anyreal) -> float64
```

**Example:**

```edgeql
select avg(Order.total);
```

**SQL equivalent:** `AVG(...)`

---

### `stddev`

Returns the sample standard deviation (equivalent to `stddev_samp`).

```
stddev(expr: anyreal) -> float64
```

**Example:**

```edgeql
select stddev(Measurement.value);
```

**SQL equivalent:** `STDDEV(...)`

---

### `stddev_pop`

Returns the population standard deviation.

```
stddev_pop(expr: anyreal) -> float64
```

**Example:**

```edgeql
select stddev_pop(Measurement.value);
```

**SQL equivalent:** `STDDEV_POP(...)`

---

### `stddev_samp`

Returns the sample standard deviation.

```
stddev_samp(expr: anyreal) -> float64
```

**Example:**

```edgeql
select stddev_samp(Measurement.value);
```

**SQL equivalent:** `STDDEV_SAMP(...)`

---

### `array_agg`

Collects a set of values into an array.

```
array_agg(expr: any) -> array
```

**Example:**

```edgeql
select array_agg(User.name);
# => ['Ada', 'Billie', 'Cher']
```

**SQL equivalent:** `ARRAY_AGG(...)`

---

## Type Conversion Functions

Type conversion functions cast values from one type to another. They compile to PostgreSQL `CAST` expressions.

### `to_str`

Converts any value to a string.

```
to_str(val: any) -> str
```

**Example:**

```edgeql
select to_str(42);
# => '42'
```

**SQL equivalent:** `CAST(42 AS text)`

---

### `to_int16`

Converts a value to a 16-bit integer.

```
to_int16(val: any) -> int16
```

**Example:**

```edgeql
select to_int16('42');
```

**SQL equivalent:** `CAST('42' AS smallint)`

---

### `to_int32`

Converts a value to a 32-bit integer.

```
to_int32(val: any) -> int32
```

**Example:**

```edgeql
select to_int32('42');
```

**SQL equivalent:** `CAST('42' AS integer)`

---

### `to_int64`

Converts a value to a 64-bit integer.

```
to_int64(val: any) -> int64
```

**Example:**

```edgeql
select to_int64('42');
```

**SQL equivalent:** `CAST('42' AS bigint)`

---

### `to_float32`

Converts a value to a 32-bit floating-point number.

```
to_float32(val: any) -> float32
```

**Example:**

```edgeql
select to_float32('3.14');
```

**SQL equivalent:** `CAST('3.14' AS real)`

---

### `to_float64`

Converts a value to a 64-bit floating-point number.

```
to_float64(val: any) -> float64
```

**Example:**

```edgeql
select to_float64('3.14');
```

**SQL equivalent:** `CAST('3.14' AS double precision)`

---

### `to_bigint`

Converts a value to an arbitrary-precision integer.

```
to_bigint(val: any) -> bigint
```

**Example:**

```edgeql
select to_bigint('999');
```

**SQL equivalent:** `CAST('999' AS numeric)`

---

### `to_decimal`

Converts a value to an arbitrary-precision decimal.

```
to_decimal(val: any) -> decimal
```

**Example:**

```edgeql
select to_decimal('1.5');
```

**SQL equivalent:** `CAST('1.5' AS numeric)`

---

### `to_bool`

Converts a value to a boolean.

```
to_bool(val: any) -> bool
```

**Example:**

```edgeql
select to_bool('true');
# => true
```

**SQL equivalent:** `CAST('true' AS boolean)`

---

### `to_uuid`

Converts a string to a UUID.

```
to_uuid(val: any) -> uuid
```

**Example:**

```edgeql
select to_uuid('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
```

**SQL equivalent:** `CAST('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' AS uuid)`

---

## JSON Functions

### `to_json`

Converts any value to JSON.

```
to_json(val: any) -> json
```

**Example:**

```edgeql
select to_json('hello');
select to_json(42);
```

**SQL equivalent:** `TO_JSONB('hello')`

---

### `json_typeof`

Returns the type of a JSON value as a string. Possible return values: `"string"`, `"number"`, `"boolean"`, `"null"`, `"object"`, `"array"`.

```
json_typeof(val: json) -> str
```

**Example:**

```edgeql
select json_typeof(to_json(42));
# => 'number'

select json_typeof(to_json('hello'));
# => 'string'
```

**SQL equivalent:** `JSONB_TYPEOF(...)`

---

### `json_get`

Retrieves a value from a JSON object by key.

```
json_get(val: json, key: str) -> json
```

**Example:**

```edgeql
select json_get(to_json('{"name": "Ada", "age": 30}'), 'name');
# => '"Ada"'
```

**SQL equivalent:** `val -> 'name'` (the `->` operator)

---

### `json_array_unpack`

Expands a JSON array into a set of JSON elements.

```
json_array_unpack(val: json) -> set of json
```

**Example:**

```edgeql
select json_array_unpack(to_json('[1, 2, 3]'));
# => {1, 2, 3} (as individual JSON values)
```

**SQL equivalent:** `JSONB_ARRAY_ELEMENTS(...)`

---

### `json_object_unpack`

Expands a JSON object into a set of key-value pairs.

```
json_object_unpack(val: json) -> set of json
```

**Example:**

```edgeql
select json_object_unpack(to_json('{"a": 1, "b": 2}'));
```

**SQL equivalent:** `JSONB_EACH(...)`

---

## Array Functions

### `array_agg`

Collects a set of values into an array. See [Aggregate Functions](#array_agg) for details.

---

### `array_unpack`

Unpacks an array into a set of individual elements.

```
array_unpack(val: array) -> set of any
```

**Example:**

```edgeql
select array_unpack([1, 2, 3]);
# => {1, 2, 3}
```

**SQL equivalent:** `UNNEST(ARRAY[1, 2, 3])`

---

### `array_join`

Joins array elements into a single string using a delimiter.

```
array_join(val: array<str>, delimiter: str) -> str
```

**Example:**

```edgeql
select array_join(['a', 'b', 'c'], ',');
# => 'a,b,c'

select array_join(['hello', 'world'], ' ');
# => 'hello world'
```

**SQL equivalent:** `ARRAY_TO_STRING(ARRAY['a','b','c'], ',')`

---

### `array_get`

Returns the element at a given 0-based index in an array.

```
array_get(val: array, index: int64) -> any
```

**Example:**

```edgeql
select array_get([10, 20, 30], 0);
# => 10

select array_get([10, 20, 30], 2);
# => 30
```

**SQL equivalent:** `(ARRAY[10,20,30])[0 + 1]`

Note: PostgreSQL arrays are 1-indexed. Disc automatically adjusts by adding 1 to the index.

---

## Set Functions

### `distinct`

Returns the distinct elements of a set, removing duplicates.

```
distinct(val: any) -> set of any
```

**Example:**

```edgeql
select distinct User.role;
```

**SQL equivalent:** `DISTINCT ...`

---

### `exists`

Returns true if a set is non-empty.

```
exists(val: any) -> bool
```

**Example:**

```edgeql
select exists(
  select User filter .email = 'admin@example.com'
);
# => true (if such a user exists)
```

Note: The EdgeQL parser treats `exists` as a unary keyword operator. It may compile to `EXISTS (subquery)` for subqueries or `expr IS NOT NULL` for scalar values.

---

### `enumerate`

Returns a set of (index, value) tuples, pairing each element with its 0-based position.

```
enumerate(val: any) -> set of tuple<int64, any>
```

**Example:**

```edgeql
select enumerate(User.name);
# => {(0, 'Ada'), (1, 'Billie'), (2, 'Cher')}
```

**SQL equivalent:** `jsonb_build_array(ROW_NUMBER() OVER () - 1, val)`

---

### `any`

Returns true if any element in a set of boolean values is true.

```
any(vals: bool) -> bool
```

**Example:**

```edgeql
select any(User.is_admin);
# => true (if at least one admin exists)
```

**SQL equivalent:** `BOOL_OR(...)`

---

### `all`

Returns true if all elements in a set of boolean values are true.

```
all(vals: bool) -> bool
```

**Example:**

```edgeql
select all(User.email_verified);
# => true (only if every user is verified)
```

**SQL equivalent:** `BOOL_AND(...)`

---

## Assertion Functions

Assertion functions are pass-through functions that enforce cardinality constraints at runtime. They do not map to a specific SQL function -- they wrap the expression and validate the result.

### `assert_exists`

Asserts that the expression returns at least one result. Raises an error if the set is empty.

```
assert_exists(expr: any) -> any
```

**Example:**

```edgeql
select assert_exists(
  (select User filter .id = <uuid>$user_id)
);
```

---

### `assert_single`

Asserts that the expression returns at most one result. Raises an error if the set contains more than one element.

```
assert_single(expr: any) -> any
```

**Example:**

```edgeql
select assert_single(
  (select User filter .email = 'unique@example.com')
);
```

---

## UUID Functions

### `uuid_generate_v4`

Generates a random UUID (version 4).

```
uuid_generate_v4() -> uuid
```

**Example:**

```edgeql
select uuid_generate_v4();
# => 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' (random each time)
```

**SQL equivalent:** `GEN_RANDOM_UUID()`

---

### `uuid_generate_v1mc`

Generates a UUID. In Disc, this maps to the same implementation as `uuid_generate_v4` because PostgreSQL 16 does not provide a built-in v1mc generator.

```
uuid_generate_v1mc() -> uuid
```

**Example:**

```edgeql
select uuid_generate_v1mc();
```

**SQL equivalent:** `GEN_RANDOM_UUID()`

---

### `disc_uuidv7`

Generates a time-ordered UUID (version 7, RFC 9562). The high 48 bits are a millisecond timestamp, so values sort chronologically and keep primary-key index inserts sequential. This is the **default** generator for every object type's `id` (Disc diverges from Gel's random v4 here). It's provided by a bootstrapped stdlib function built on `pgcrypto`, so it works on PostgreSQL 16/17/18 without relying on PG 18's native `uuidv7()`.

```
disc_uuidv7() -> uuid
```

**Example:**

```edgeql
select disc_uuidv7();
# => '019ef662-b2a4-77a9-a6b3-c1d5c2208af9' (time-ordered)
```

**SQL equivalent:** `disc_uuidv7()` (Disc stdlib function)

---

## Datetime Functions

### `datetime_current`

Returns the current date and time (with time zone).

```
datetime_current() -> datetime
```

**Example:**

```edgeql
select datetime_current();
# => '2026-03-20T14:30:00+00:00'
```

Commonly used as a default value in schema definitions:

```esdl
type User {
  created_at: datetime {
    default := datetime_current();
  };
};
```

**SQL equivalent:** `NOW()`

---

### `datetime_of_transaction`

Returns the timestamp of the current transaction. Unlike `datetime_current()`, this value remains constant for the duration of the transaction.

```
datetime_of_transaction() -> datetime
```

**Example:**

```edgeql
select datetime_of_transaction();
```

**SQL equivalent:** `TRANSACTION_TIMESTAMP()`

---

### `datetime_of_statement`

Returns the timestamp of the current statement. This value remains constant for the duration of a single statement but may change between statements in a transaction.

```
datetime_of_statement() -> datetime
```

**Example:**

```edgeql
select datetime_of_statement();
```

**SQL equivalent:** `STATEMENT_TIMESTAMP()`

---

### `datetime_get`

Extracts a component (field) from a datetime value. Valid fields include `'year'`, `'month'`, `'day'`, `'hour'`, `'minute'`, `'second'`, `'epoch'`, and others supported by PostgreSQL’s `EXTRACT`.

```
datetime_get(val: datetime, field: str) -> float64
```

**Example:**

```edgeql
select datetime_get(datetime_current(), 'year');
# => 2026

select datetime_get(datetime_current(), 'month');
# => 3
```

**SQL equivalent:** `EXTRACT(year FROM NOW())`

---

### `datetime_truncate`

Truncates a datetime value to the specified precision. Valid fields include `'year'`, `'month'`, `'day'`, `'hour'`, `'minute'`, `'second'`.

```
datetime_truncate(val: datetime, field: str) -> datetime
```

**Example:**

```edgeql
select datetime_truncate(datetime_current(), 'month');
# => '2026-03-01T00:00:00+00:00'
```

**SQL equivalent:** `DATE_TRUNC('month', NOW())`

---

### `to_datetime`

Converts a string or other value to a datetime (timestamp with time zone).

```
to_datetime(val: any) -> datetime
```

**Example:**

```edgeql
select to_datetime('2024-01-01');
select to_datetime('2024-01-01T12:00:00Z');
```

**SQL equivalent:** `CAST('2024-01-01' AS timestamp with time zone)`

---

### `to_duration`

Converts a string to a duration (interval).

```
to_duration(val: any) -> duration
```

**Example:**

```edgeql
select to_duration('PT1H');
select to_duration('P1DT12H');
```

**SQL equivalent:** `CAST('PT1H' AS interval)`

---

### `cal_to_local_date`

Converts a value to a local date (date without time zone information).

```
cal_to_local_date(val: any) -> cal::local_date
```

**Example:**

```edgeql
select cal::to_local_date('2024-01-01');
```

**SQL equivalent:** `CAST('2024-01-01' AS date)`

---

### `cal_to_local_time`

Converts a value to a local time (time without time zone information).

```
cal_to_local_time(val: any) -> cal::local_time
```

**Example:**

```edgeql
select cal::to_local_time('12:00:00');
```

**SQL equivalent:** `CAST('12:00:00' AS time without time zone)`

---

### `cal_to_local_datetime`

Converts a value to a local datetime (timestamp without time zone information).

```
cal_to_local_datetime(val: any) -> cal::local_datetime
```

**Example:**

```edgeql
select cal::to_local_datetime('2024-01-01T12:00:00');
```

**SQL equivalent:** `CAST('2024-01-01T12:00:00' AS timestamp without time zone)`

---

## Window Functions

Window functions operate over a partition (window) of rows and are used with the `OVER` clause. These functions cannot be called without a window specification.

### `row_number`

Returns the sequential number of the current row within its partition, starting from 1.

```
row_number() -> int64
```

**Example:**

```edgeql
select User {
  name,
  row_num := row_number() over (order by .name)
};
```

**SQL equivalent:** `ROW_NUMBER() OVER (...)`

---

### `rank`

Returns the rank of the current row within its partition, with gaps for ties.

```
rank() -> int64
```

**Example:**

```edgeql
select Student {
  name,
  score_rank := rank() over (order by .score desc)
};
```

**SQL equivalent:** `RANK() OVER (...)`

---

### `dense_rank`

Returns the rank of the current row within its partition, without gaps for ties.

```
dense_rank() -> int64
```

**Example:**

```edgeql
select Student {
  name,
  score_rank := dense_rank() over (order by .score desc)
};
```

**SQL equivalent:** `DENSE_RANK() OVER (...)`

---

### `ntile`

Distributes the rows in an ordered partition into a specified number of groups (buckets).

```
ntile(n: int64) -> int64
```

**Example:**

```edgeql
select Product {
  name,
  price_quartile := ntile(4) over (order by .price)
};
```

**SQL equivalent:** `NTILE(4) OVER (...)`

---

### `lag`

Returns the value of an expression evaluated at the row that is a given offset before the current row within the partition. Returns default (or null) if no such row exists.

```
lag(expr: any, offset?: int64, default?: any) -> any
```

**Example:**

```edgeql
select Sale {
  date,
  amount,
  prev_amount := lag(.amount, 1) over (order by .date)
};
```

**SQL equivalent:** `LAG(amount, 1) OVER (...)`

---

### `lead`

Returns the value of an expression evaluated at the row that is a given offset after the current row within the partition. Returns default (or null) if no such row exists.

```
lead(expr: any, offset?: int64, default?: any) -> any
```

**Example:**

```edgeql
select Sale {
  date,
  amount,
  next_amount := lead(.amount, 1) over (order by .date)
};
```

**SQL equivalent:** `LEAD(amount, 1) OVER (...)`

---

### `first_value`

Returns the value of an expression evaluated at the first row of the window frame.

```
first_value(expr: any) -> any
```

**Example:**

```edgeql
select Sale {
  date,
  amount,
  first_sale := first_value(.amount) over (order by .date)
};
```

**SQL equivalent:** `FIRST_VALUE(amount) OVER (...)`

---

### `last_value`

Returns the value of an expression evaluated at the last row of the window frame.

```
last_value(expr: any) -> any
```

**Example:**

```edgeql
select Sale {
  date,
  amount,
  last_sale := last_value(.amount) over (order by .date)
};
```

**SQL equivalent:** `LAST_VALUE(amount) OVER (...)`

---

## Bytes Functions

### `bytes_get_bit`

Returns the value of a specific bit (0 or 1) at the given index in a byte string.

```
bytes_get_bit(val: bytes, index: int64) -> int64
```

**Example:**

```edgeql
select bytes_get_bit(b'\xff', 0);
# => 1
```

**SQL equivalent:** `GET_BIT(..., 0)`

---

### `bytes_to_str`

Converts a byte string to a text string using the specified encoding.

```
bytes_to_str(val: bytes, encoding: str) -> str
```

**Example:**

```edgeql
select bytes_to_str(b'hello', 'UTF8');
# => 'hello'
```

**SQL equivalent:** `CONVERT_FROM(..., 'UTF8')`

---

## Range Functions

Range functions operate on range types, which represent a span of values with optional inclusive/exclusive bounds.

### `range`

Creates a range from a lower and upper bound.

```
range(lower: any, upper: any) -> range
```

**Example:**

```edgeql
select range(1, 10);
```

---

### `range_get_lower`

Returns the lower bound of a range.

```
range_get_lower(r: range) -> any
```

**Example:**

```edgeql
select range_get_lower(range(1, 10));
# => 1
```

**SQL equivalent:** `LOWER(int4range(1, 10))`

---

### `range_get_upper`

Returns the upper bound of a range.

```
range_get_upper(r: range) -> any
```

**Example:**

```edgeql
select range_get_upper(range(1, 10));
# => 10
```

**SQL equivalent:** `UPPER(int4range(1, 10))`

---

### `range_is_empty`

Returns true if the range is empty.

```
range_is_empty(r: range) -> bool
```

**Example:**

```edgeql
select range_is_empty(range(1, 1));
# => true
```

**SQL equivalent:** `ISEMPTY(int4range(1, 1))`

---

### `range_unpack`

Unpacks a range into a set of its individual values (for discrete ranges like integer ranges).

```
range_unpack(r: range) -> set of any
```

**Example:**

```edgeql
select range_unpack(range(1, 5));
# => {1, 2, 3, 4}
```

**SQL equivalent:** `UNNEST(int4range(1, 5))`

---

### `range_is_inclusive_lower`

Returns true if the lower bound of the range is inclusive.

```
range_is_inclusive_lower(r: range) -> bool
```

**Example:**

```edgeql
select range_is_inclusive_lower(range(1, 10));
# => true
```

**SQL equivalent:** `LOWER_INC(int4range(1, 10))`

---

### `range_is_inclusive_upper`

Returns true if the upper bound of the range is inclusive.

```
range_is_inclusive_upper(r: range) -> bool
```

**Example:**

```edgeql
select range_is_inclusive_upper(range(1, 10));
# => false
```

**SQL equivalent:** `UPPER_INC(int4range(1, 10))`

---

### `multirange`

Creates a multirange from one or more ranges.

```
multirange(r: range) -> multirange
```

**Example:**

```edgeql
select multirange(range(1, 5));
```

---

### `overlaps`

Returns true if two ranges overlap.

```
overlaps(r1: range, r2: range) -> bool
```

**Example:**

```edgeql
select overlaps(range(1, 5), range(3, 8));
# => true

select overlaps(range(1, 3), range(5, 8));
# => false
```

**SQL equivalent:** `r1 && r2` (the `&&` overlap operator)

---

### `contains` (range overload)

Returns true if a range contains an element. This is the range overload of the `contains` function.

```
contains(r: range, elem: any) -> bool
```

**Example:**

```edgeql
select contains(range(1, 10), 5);
# => true
```

**SQL equivalent:** `r @> elem` (the `@>` containment operator)

---

## Sequence Functions

Sequence functions interact with PostgreSQL sequences for generating auto-incrementing values.

### `sequence_next`

Returns the next value from a named sequence.

```
sequence_next(name: str) -> int64
```

**Example:**

```edgeql
select sequence_next('my_seq');
# => 1 (then 2, 3, etc.)
```

**SQL equivalent:** `NEXTVAL('my_seq')`

---

### `sequence_reset`

Resets a named sequence to a specified value.

```
sequence_reset(name: str, val: int64) -> int64
```

**Example:**

```edgeql
select sequence_reset('my_seq', 1);
```

**SQL equivalent:** `SETVAL('my_seq', 1)`

---

## Schema Introspection Functions

Schema introspection functions provide runtime access to the database schema. They are resolved at compile time and return JSON representations of schema metadata.

### `schema::types`

Returns a JSON array describing all object types in the schema.

```
schema::types() -> json
```

**Example:**

```edgeql
select schema::types();
```

---

### `schema::get_type`

Returns a JSON object describing a specific type by name.

```
schema::get_type(name: str) -> json
```

**Example:**

```edgeql
select schema::get_type('User');
```

---

### `schema::functions`

Returns a JSON array describing all registered functions.

```
schema::functions() -> json
```

**Example:**

```edgeql
select schema::functions();
```

---

## Full-Text Search Functions

Full-text search functions are part of the `fts` extension (`ext::fts`). They require an `fts::index` to be defined on the target type in your schema.

### `fts::search`

Returns true if a row’s full-text search vector matches the given query string. Typically used in `filter` clauses.

```
fts::search(query: str) -> bool
```

**Example:**

```edgeql
select Article {
  title,
  body
} filter fts::search('database migration');
```

**SQL equivalent:** `fts_vector @@ plainto_tsquery('english', 'database migration')`

The query string is parsed using PostgreSQL’s `plainto_tsquery` with the English language configuration by default.

---

### `fts::rank`

Returns a relevance score for a full-text search query against a row’s search vector. Higher values indicate better matches. Useful for ordering search results.

```
fts::rank(query: str) -> float64
```

**Example:**

```edgeql
select Article {
  title,
  body,
  relevance := fts::rank('database migration')
}
filter fts::search('database migration')
order by fts::rank('database migration') desc;
```

**SQL equivalent:** `ts_rank(fts_vector, plainto_tsquery('english', 'database migration'))`

---

## Function Categories Quick Reference

| Category         | Functions                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| String           | `len`, `str_lower`, `str_upper`, `str_title`, `str_trim`, `str_ltrim`, `str_rtrim`, `str_repeat`, `str_replace`, `str_split`, `str_starts_with`, `str_ends_with`, `str_pad_start`, `str_pad_end`, `contains`, `find` |
| Regex            | `re_match`, `re_match_all`, `re_replace`, `re_test`                                                                                                                                                                  |
| Math             | `random`, `math_abs`, `math_ceil`, `math_floor`, `round`, `math_sqrt`, `math_pow`, `math_power`, `math_log`, `math_ln`, `math_log10`, `math_log2`, `math_pi`, `math_e`, `math_mean`                                  |
| Aggregate        | `count`, `sum`, `min`, `max`, `avg`, `stddev`, `stddev_pop`, `stddev_samp`, `array_agg`, `any`, `all`                                                                                                                |
| Type Conversion  | `to_str`, `to_int16`, `to_int32`, `to_int64`, `to_float32`, `to_float64`, `to_bigint`, `to_decimal`, `to_bool`, `to_uuid`                                                                                            |
| JSON             | `to_json`, `json_typeof`, `json_get`, `json_array_unpack`, `json_object_unpack`                                                                                                                                      |
| Array            | `array_agg`, `array_unpack`, `array_join`, `array_get`                                                                                                                                                               |
| Set              | `distinct`, `exists`, `enumerate`, `any`, `all`                                                                                                                                                                      |
| Assertion        | `assert_exists`, `assert_single`                                                                                                                                                                                     |
| UUID             | `disc_uuidv7`, `uuid_generate_v4`, `uuid_generate_v1mc`                                                                                                                                                              |
| Datetime         | `datetime_current`, `datetime_of_transaction`, `datetime_of_statement`, `datetime_get`, `datetime_truncate`, `to_datetime`, `to_duration`                                                                            |
| Calendar         | `cal_to_local_date`, `cal_to_local_time`, `cal_to_local_datetime`                                                                                                                                                    |
| Window           | `row_number`, `rank`, `dense_rank`, `ntile`, `lag`, `lead`, `first_value`, `last_value`                                                                                                                              |
| Bytes            | `bytes_get_bit`, `bytes_to_str`                                                                                                                                                                                      |
| Range            | `range`, `range_get_lower`, `range_get_upper`, `range_is_empty`, `range_unpack`, `range_is_inclusive_lower`, `range_is_inclusive_upper`, `multirange`, `overlaps`, `contains` (overload)                             |
| Sequence         | `sequence_next`, `sequence_reset`                                                                                                                                                                                    |
| Introspection    | `schema::types`, `schema::get_type`, `schema::functions`                                                                                                                                                             |
| Full-Text Search | `fts::search`, `fts::rank`                                                                                                                                                                                           |
