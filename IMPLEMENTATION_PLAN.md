# Disc Database — Implementation Plan

> Last Updated: 2026-03-19
> Status: Gel Parity — Tiers 1-2 Complete, Tier 3 In Progress
> Gap Analysis: `thoughts/shared/plans/2026-03-19-gel-parity-gap-analysis.md`

## Completed Work (Phases 1-36)

All core database integration, production infrastructure, and advanced SDL features are complete. **1739 tests passing.**

- Phases 1-9: Core execution, PG integration, CLI, auth, access policies, caching, production hardening
- Phases 10-15: Advanced queries, extensions, client SDK, codegen, CLI docs
- Phases 16-19: Deployment tooling, production E2E tests
- Phases 20-24: Advanced expressions, junction tables, polymorphism, multi-database, introspection
- Stages 25-29: Constraints, cal types, standard library (88 functions), indexing/slicing, multiple inheritance
- Stages 31-35: Triggers, rewrites, aliases, range/multirange types, collection types, deletion policies, link inheritance, polymorphic types
- Stage 36: Globals (session variables) — GlobalDef, SET GLOBAL, access policy integration, PG session vars
- Stage 37: Operators — Bitwise (&, |, ^, <<, >>, ~), Regex (~, !~, ~*, !~*), EXPLAIN queries
- Stage 38: CONFIGURE queries — SESSION/DATABASE/INSTANCE/SYSTEM SET/RESET, config key mapping, disc_config table

---

## Tier 1: Blocks Any Migration

These features are used in nearly every real-world Gel application.

### Stage 25: Built-in Constraints

**Goal**: Support all standard Gel constraints in SDL, validation, and DDL
**Success Criteria**: Schema files using these constraints parse, validate, and generate correct CHECK/UNIQUE DDL
**Tests**: SDL parsing, validation, DDL generation, PG E2E for each constraint type
**Status**: Complete

Tasks:
- [x] Add constraint types to schema AST: `max_len_value`, `min_len_value`, `max_value`, `min_value`, `max_ex_value`, `min_ex_value`, `one_of`, `expression on`
- [x] Update SDL parser to handle constraint arguments (single value and multi-value)
- [x] Update schema validator to type-check constraint arguments against property types
- [x] Update DDL generator to emit correct CHECK constraints:
  - `max_len_value(n)` → `CHECK (LENGTH(col) <= n)`
  - `min_len_value(n)` → `CHECK (LENGTH(col) >= n)`
  - `max_value(v)` → `CHECK (col <= v)`
  - `min_value(v)` → `CHECK (col >= v)`
  - `max_ex_value(v)` → `CHECK (col < v)`
  - `min_ex_value(v)` → `CHECK (col > v)`
  - `one_of(...)` → `CHECK (col IN (...))`
  - `expression on (expr)` → `CHECK (expr)`
- [x] Update migration differ to detect constraint changes (AddConstraint/DropConstraint)
- [x] Add delegated constraint support (inherited by subtypes via extractPropertiesWithInheritance)
- [x] PG E2E tests: insert valid/invalid data against each constraint type (6 PG E2E tests)
- [x] Constraint validation: arg count, type compatibility (12 validator tests)

---

### Stage 26: Calendar Types

**Goal**: Support all `cal::` types throughout the stack
**Success Criteria**: SDL properties with cal types parse, compile to correct PG types, and round-trip through queries
**Tests**: SDL parsing, type resolution, DDL generation, query compilation, PG E2E
**Status**: Complete

Tasks:
- [x] Add types to type system: `cal::local_date`, `cal::local_time`, `cal::local_datetime`, `cal::relative_duration`, `cal::date_duration`
- [x] Update SDL parser to resolve `cal::` module-qualified types (validator + converter)
- [x] Map to PostgreSQL types:
  - `cal::local_date` → `DATE`
  - `cal::local_time` → `TIME WITHOUT TIME ZONE`
  - `cal::local_datetime` → `TIMESTAMP WITHOUT TIME ZONE`
  - `cal::relative_duration` → `INTERVAL`
  - `cal::date_duration` → `INTERVAL`
- [x] Update DDL generator for cal type columns (migration/ddl.ts mapEdgeQLTypeToPostgreSQL)
- [x] Update compiler type mapping (compiler/compiler.ts edgeqlTypeToPgType)
- [x] Update codegen to emit TypeScript types (Date for local_datetime, string for others)
- [x] Update cast map and SDL→SQL type maps for all 5 cal types
- [x] Update schema validator: cal types as valid built-in types, value constraints allowed on cal types
- [x] Cal conversion functions deferred to Stage 27 (cal::to_local_date, etc.)
- [x] 43 unit tests (compiler/cal-types.test.ts)
- [x] 6 PG E2E tests (compiler/pg-cal-types.test.ts): DDL column type verification + value round-trip

---

### Stage 27: Built-in Functions — Complete Standard Library

**Goal**: Implement all missing Gel standard library functions
**Success Criteria**: All Gel std functions compile to correct SQL and execute against PG
**Tests**: Unit tests per function, PG E2E for each category
**Status**: Complete

Tasks (by category):

**String functions**:
- [x] `str_title` → `INITCAP`
- [x] `str_split` → `STRING_TO_ARRAY`
- [x] `str_starts_with` → `STARTS_WITH` (PG 15+)
- [x] `str_ends_with` → `RIGHT(s, LENGTH(suffix)) = suffix`

**Math functions** (module-qualified `math::`):
- [x] `math::sqrt` → `SQRT`
- [x] `math::pow` → `POWER`
- [x] `math::log` → `LOG`
- [x] `math::ln` → `LN`
- [x] `math::pi` → `PI()`
- [x] `math::e` → `EXP(1)` (special compilation)
- [x] `math::mean` → alias for `AVG` (windowCompatible)

**Regex functions** (argument order swapped for PG):
- [x] `re_match` → `REGEXP_MATCH` (args swapped: str, pattern)
- [x] `re_match_all` → `REGEXP_MATCHES(str, pattern, 'g')`
- [x] `re_replace` → `REGEXP_REPLACE(str, pattern, sub)` (args reordered)
- [x] `re_test` → `str ~ pattern` (boolean)

**Datetime functions**:
- [x] `datetime_get` → `EXTRACT(field FROM val)`
- [x] `datetime_of_transaction` → `TRANSACTION_TIMESTAMP()`
- [x] `datetime_truncate` → `DATE_TRUNC(field, val)`
- [x] `to_datetime` → `CAST(val AS TIMESTAMPTZ)`
- [x] `to_duration` → `CAST(val AS INTERVAL)`

**Calendar conversion functions**:
- [x] `cal::to_local_date` → `CAST(val AS DATE)`
- [x] `cal::to_local_time` → `CAST(val AS TIME WITHOUT TIME ZONE)`
- [x] `cal::to_local_datetime` → `CAST(val AS TIMESTAMP WITHOUT TIME ZONE)`

**JSON functions**:
- [x] `to_json` → `TO_JSONB`
- [x] `json_typeof` → `JSONB_TYPEOF`
- [x] `json_array_unpack` → `JSONB_ARRAY_ELEMENTS`
- [x] `json_object_unpack` → `JSONB_EACH`
- [x] `json_get` → `->` operator (JsonbAccessExpression)

**Array functions**:
- [x] `array_get` → `arr[n+1]` (1-indexed RawSQLExpression)
- [x] `array_unpack` → `UNNEST`
- [x] `array_join` → `ARRAY_TO_STRING`

**Type converter functions**:
- [x] `to_int16` → `CAST AS smallint`
- [x] `to_int32` → `CAST AS integer`
- [x] `to_float32` → `CAST AS real`
- [x] `to_bigint` → `CAST AS numeric`
- [x] `to_decimal` → `CAST AS numeric`
- [x] `to_bool` → `CAST AS boolean`
- [x] `to_uuid` → `CAST AS uuid`

**UUID functions**:
- [x] `uuid_generate_v4` → `GEN_RANDOM_UUID`

**Generic set functions**:
- [x] `any` → `BOOL_OR` (windowCompatible)
- [x] `all` → `BOOL_AND` (windowCompatible)
- [x] `exists` → `IS NOT NULL` (note: parser also handles `exists` as unary keyword operator → `EXISTS`)
- [x] `enumerate` → `jsonb_build_array(ROW_NUMBER() OVER () - 1, val)`
- [x] `distinct` → `DISTINCT val`

**Sequence functions**:
- [x] `sequence_next` → `NEXTVAL`
- [x] `sequence_reset` → `SETVAL`

**Tests**:
- [x] 43 unit tests (compiler/stage27-functions.test.ts)
- [x] 24 PG E2E tests (compiler/pg-stage27.test.ts)
- [x] SQLCodeGenerator.generateExpression() made public for RawSQLExpression rendering

---

### Stage 28: Indexing & Slicing Expressions

**Goal**: Support `[]` indexing and `[start:end]` slicing on strings, arrays, JSON, and bytes
**Success Criteria**: Gel-compatible indexing/slicing compiles and executes correctly
**Tests**: Unit tests per type, PG E2E
**Status**: Complete

Tasks:
- [x] Add `IndexExpression` and `SliceExpression` AST nodes to EdgeQL parser
- [x] Parse `expr[index]` and `expr[start:end]` syntax (all 5 variants: `[n]`, `[a:b]`, `[a:]`, `[:b]`, `[:]`)
- [x] Compile string slicing: `str[a:b]` → `SUBSTRING(str FROM a+1 FOR b-a)`
- [x] Compile array indexing: `arr[n]` → `arr[CASE WHEN n<0 THEN CARDINALITY+n+1 ELSE n+1 END]`
- [x] Compile JSON indexing: `json['key']` → `json->'key'`, `<json>val[n]` → `json->n`
- [x] Handle negative indices via CARDINALITY-based CASE WHEN
- [x] 20 unit tests (compiler/indexing-slicing.test.ts)
- [x] 10 PG E2E tests (compiler/pg-indexing-slicing.test.ts)
- [x] Fix polymorphic test regression (__index__ → IndexExpression)

---

### Stage 29: Multiple Inheritance

**Goal**: Support `type X extending A, B, C` in SDL
**Success Criteria**: Types extending multiple parents inherit all properties/links, DDL creates correct table structure
**Tests**: SDL parsing, validation, DDL generation, query compilation, PG E2E
**Status**: Complete

Tasks:
- [x] SDL parser already supports comma-separated extends list (parseTypeRefList)
- [x] Schema validator already iterates all parents for validation
- [x] Conflict resolution: first-seen-wins for diamond problem (seenNames set deduplication)
- [x] TypeDef.parentType → parentTypes (string[]) across compiler/context.ts, migration/types.ts
- [x] SchemaManager: extract all parents from extending[], multi-parent merge in inheritance pass
- [x] DDL generator: discriminator column check uses parentTypes array
- [x] Migration differ: stores all parent names in op.parentTypes array
- [x] Compiler getTypeHierarchy(): BFS traversal across multiple parent chains (no duplicates)
- [x] Introspection: parentTypes reported as string[] array
- [x] Codegen: generates `export interface X extends A, B { }` for multi-parent types
- [x] 8 unit tests (compiler/multiple-inheritance.test.ts)
- [x] 4 PG E2E tests (compiler/pg-multiple-inheritance.test.ts)

---

### Stage 30: Type Converter Functions

**Goal**: Complete all `to_*` cast functions
**Success Criteria**: All Gel cast functions compile correctly
**Tests**: Unit + PG E2E per function
**Status**: Not Started

(Merged into Stage 27 — listed separately for tracking)

---

## Tier 2: Blocks Complex Schemas

These features are used in advanced Gel applications and enterprise schemas.

### Stage 31: Triggers

**Goal**: Support trigger definitions in SDL, DDL generation, and PG execution
**Success Criteria**: Triggers defined in SDL create corresponding PG triggers
**Tests**: SDL parsing, DDL generation, PG E2E trigger execution
**Status**: Complete

Tasks:
- [x] Add TRIGGER token to schema/tokens.ts, TriggerDeclaration AST node to schema/ast.ts
- [x] Update SDL parser for trigger syntax (parseTriggerDeclaration, parseTriggerEvents)
- [x] Update schema validator (duplicate trigger names, duplicate events, empty events)
- [x] Add TriggerDefinition, AddTriggerOperation, DropTriggerOperation to migration/types.ts
- [x] Migration differ: extractTriggers(), diffTriggers() with drop+add for modifications
- [x] DDL generation: CREATE FUNCTION + CREATE TRIGGER, __new__/OLD/__action__ substitution
- [x] TriggerDef on TypeDef (compiler/context.ts), SchemaManager trigger extraction
- [x] 25 unit tests (migration/trigger.test.ts): parser, validator, differ, DDL, end-to-end
- [x] 5 PG E2E tests (migration/pg-trigger.test.ts): INSERT/UPDATE/DELETE triggers, multi-event, DDLGenerator output

---

### Stage 32: Rewrite Rules

**Goal**: Support `rewrite` declarations in SDL for auto-computed values on INSERT/UPDATE
**Success Criteria**: Rewrite rules execute transparently during mutations
**Tests**: SDL parsing, DDL generation, PG E2E
**Status**: Complete

Tasks:
- [x] Add REWRITE token to schema/tokens.ts, RewriteDeclaration AST node to schema/ast.ts
- [x] Update SDL parser for rewrite syntax in parsePropertyBody() (parseRewriteDeclaration)
- [x] Update schema validator (duplicate events, invalid events, empty expression)
- [x] Add RewriteDefinition, AddRewriteOperation, DropRewriteOperation to migration/types.ts
- [x] Migration differ: extractRewrites(), diffRewrites() with drop+add for modifications
- [x] DDL generation: BEFORE trigger + PL/pgSQL function, datetime_of_statement→statement_timestamp substitution
- [x] RewriteDef on PropertyDef (compiler/context.ts), SchemaManager rewrite extraction
- [x] 26 unit tests (migration/rewrite.test.ts): parser, validator, differ, DDL, end-to-end
- [x] 5 PG E2E tests (migration/pg-rewrite.test.ts): INSERT/UPDATE/combined rewrites, __old__ reference, DDLGenerator output

---

### Stage 33: Expression Aliases

**Goal**: Support `alias` declarations in SDL
**Success Criteria**: Aliases can be queried as if they were types
**Tests**: SDL parsing, query compilation, PG E2E
**Status**: Complete

Tasks:
- [x] AliasDef interface, Schema.aliases field, resolveAlias() 3-step resolution
- [x] SchemaManager AliasDeclaration extraction, stringifyExpression() fix
- [x] Compiler integration: alias fallback in TypeName + Identifier branches, compileAliasExpression()
- [x] Migration layer: CreateAlias/DropAlias operations, extractAliases(), alias diffing, no-op DDL
- [x] 9 compiler tests (alias-compilation.test.ts), 8 migration tests (alias.test.ts), 4 PG E2E tests (pg-alias.test.ts)

---

### Stage 34: Range & Multirange Types

**Goal**: Support `range<T>` and `multirange<T>` throughout the stack
**Success Criteria**: Range properties work in SDL, queries, and PG execution
**Tests**: SDL parsing, DDL, query compilation, PG E2E
**Status**: Complete

Tasks:
- [x] Phase 1: Add range/multirange to type system with parameterized type support
  - Schema AST `TypeRef.params`, SDL parser angle-bracket type params, validator range inner types
  - DDL generator range type mapping, migration differ `typeToString()`, compiler type mapping
  - 18 unit tests (compiler/range-types.test.ts)
- [x] Phase 2: Range & multirange built-in functions
  - `range(lower, upper)` → PG range constructor (`int4range`, `numrange`, etc.)
  - `range_get_lower` → `LOWER`, `range_get_upper` → `UPPER`, `range_is_empty` → `ISEMPTY`
  - `range_unpack` → `UNNEST`, `range_is_inclusive_lower` → `LOWER_INC`, `range_is_inclusive_upper` → `UPPER_INC`
  - `contains(range, elem)` → `@>`, `overlaps(r1, r2)` → `&&`, `multirange()` → PG multirange constructor
  - 14 unit tests (compiler/range-functions.test.ts)
- [x] Phase 3: Range operators in EdgeQL parser and compiler
  - `@>` (contains), `<@` (contained by), `&&` (overlaps), `-|-` (adjacent)
  - New token types, lexer rules, parser integration at comparison precedence level
  - Direct pass-through to PG operators (same syntax)
  - 8 unit tests (compiler/range-operators.test.ts)
- [x] Phase 4: PG E2E tests (compiler/pg-range-types.test.ts)
  - DDL column creation (int4range, int8multirange), INSERT+SELECT round-trip
  - range_get_lower/range_get_upper, range_is_empty, contains (@>), overlaps (&&)
  - @> operator in FILTER clause, datetime range (tstzrange), multirange construction
  - 10 PG E2E tests

---

### Stage 35: Remaining SDL Features

**Goal**: Implement remaining SDL features for complex schemas
**Success Criteria**: All features parse, validate, and generate correct DDL
**Tests**: SDL parsing, DDL, PG E2E
**Status**: Complete

Tasks:
- [x] Collection type properties: `array<T>` → `T[]`, `tuple<T1,T2>` → `JSONB`
  - Parser comma-separated params, validator array/tuple rules, DDL/schema-manager/compiler/converter type mappings (21 tests)
- [x] Deletion policies: `on target delete set empty` → `SET NULL` FK, `on source delete delete target` → `BEFORE DELETE` trigger
  - Parser target/source branching, differ/DDL generation (12 tests)
- [x] Link inheritance: `extending` on LinkDeclaration, abstract link parsing
  - Schema-manager property/constraint merging (concrete-wins), validator cycle detection, differ extending diff (9 tests)
- [x] Abstract polymorphic types: `POLYMORPHIC_TYPES` set (9 types: anytype, anyscalar, anyreal, anyint, anyfloat, anyenum, anytuple, anyobject, scalar)
  - `isPolymorphicType()` utility, validator acceptance (12 unit + 7 PG E2E tests)

---

## Tier 3: Runtime Features & Client Compatibility

### Stage 36: Globals (Session Variables)

**Goal**: Support `global` declarations as session-scoped variables accessible in queries and access policies
**Success Criteria**: Globals declared in SDL can be set per-session and referenced in EdgeQL queries and access policies
**Tests**: SDL parsing (already works), compiler resolution, migration DDL, session management, PG E2E
**Status**: Complete

PG mechanism: `set_config('disc.global_default__name', value, true)` (transaction-scoped) + `current_setting('disc.global_default__name', true)::pgtype` (retrieval with NULL for unset).

Tasks:
- [x] Phase 1: Compiler context — GlobalDef interface, Schema.globals field, resolveGlobal() 3-step resolution
  - SchemaManager: extract GlobalDeclaration from parsed modules, populate Schema.globals
  - 7 unit tests (compiler/globals.test.ts): extraction, resolution by exact/module/default/unknown, createTestSchema
- [x] Phase 2: EdgeQL parsing — GlobalRef AST node + SET GLOBAL statement
  - Parser: `global name` → GlobalRef, `global module::name` → qualified GlobalRef
  - Parser: `SET GLOBAL name := expr` → SetGlobalQuery
  - 5 unit tests (edgeql/global-parser.test.ts): unqualified/qualified refs, SET GLOBAL simple/qualified/numeric
- [x] Phase 3: Compiler — GlobalRef to SQL, SetGlobal to SQL
  - `global current_user_id` → `CAST(current_setting('disc.global_default__current_user_id', TRUE) AS uuid)`
  - `SET GLOBAL name := expr` → `SET LOCAL "disc.global_default__name" TO valueSql` (via RawSQLStatement)
  - Readonly global SET throws CompilationError, unknown global throws CompilationError
  - 6 unit tests (compiler/globals-compilation.test.ts)
- [x] Phase 4: Access policy integration — dynamic schema-driven globals
  - evaluateGlobal(): check context.globals map first, fall back to hardcoded 3 built-ins
  - expressionToSQL(): custom globals emit `current_setting('global default::name', true)`
  - authContextToAccessContext() accepts optional sessionGlobals parameter
  - 3 new tests in access/evaluator.test.ts (49 total)
- [x] Phase 5: Server + migration + PG E2E
  - Protocol handler: SET GLOBAL stores in session.variables, injects set_config() before queries
  - Migration: CreateGlobal/DropGlobal operations (no-op DDL, compile-time only)
  - Differ: extractGlobals(), diff globals (add/remove/modify = drop+add)
  - 4 migration tests (migration/globals.test.ts)
  - 5 PG E2E tests (compiler/pg-globals.test.ts): filter, unset NULL, SET+query, required unset, access policy style

---

### Stage 37: Operators — Bitwise, Regex & EXPLAIN

**Goal**: Support all remaining Gel operators and EXPLAIN queries
**Success Criteria**: Operators parse and compile to correct PG SQL; EXPLAIN returns query plans
**Tests**: 31 unit tests + 12 PG E2E tests
**Status**: Complete

Tasks:
- [x] Phase 1: Bitwise operators in EdgeQL
  - Tokens: AMPERSAND (`&`), PIPE (`|`), CARET (`^`), LSHIFT (`<<`), RSHIFT (`>>`), TILDE (`~` unary)
  - Lexer: `&`/`&&` disambiguation, `<<`/`>>` in `<`/`>` branches, `^` and `~`/`~*` new cases
  - Parser: `parseBitwiseExpression()` precedence level between concat and additive
  - Compiler: direct PG mapping (`^` → `#` for PG XOR), unary `~` pass-through
  - 8 unit tests: each operator, precedence, nested expressions
- [x] Phase 2: Regex operators in EdgeQL
  - Tokens: REGEX_NOT_MATCH (`!~`), REGEX_IMATCH (`~*`), REGEX_NOT_IMATCH (`!~*`); TILDE for binary `~`
  - Lexer: `!~`/`!~*` in `!` branch, `~*` in `~` branch
  - Parser: `~`, `!~`, `~*`, `!~*` at comparison precedence (like LIKE/ILIKE)
  - Compiler: direct PG mapping (same operators)
  - Context disambiguation: unary TILDE = bitwise NOT, binary TILDE = regex match
  - 6 unit tests + 2 disambiguation tests
- [x] Phase 3: EXPLAIN queries
  - EdgeQL AST: `ExplainQuery` node with query, analyze, buffers fields
  - Tokens: EXPLAIN, ANALYZE keywords
  - Parser: `EXPLAIN [ANALYZE] [BUFFERS] <query>` — BUFFERS as contextual IDENT
  - Compiler: wraps compiled inner SQL in `EXPLAIN (FORMAT JSON[, ANALYZE][, BUFFERS])`
  - 7 unit tests: parsing, compilation, options
- [x] Phase 4: PG E2E tests (compiler/pg-stage37.test.ts)
  - Bitwise: AND (255&15=15), OR (12|10=14), XOR (5#3=6), LSHIFT (1<<4=16), RSHIFT (16>>2=4), NOT (~0=-1)
  - Regex: `~` match, `!~` not match, `~*` case-insensitive, `!~*` case-insensitive not match
  - EXPLAIN: JSON plan output, EXPLAIN ANALYZE timing info

---

### Stage 38: CONFIGURE Queries

**Goal**: Support runtime configuration via EdgeQL
**Success Criteria**: `CONFIGURE` queries modify PG settings and Disc config
**Tests**: 18 unit tests + 4 PG E2E tests
**Status**: Complete

Tasks:
- [x] Phase 1: Parser — CONFIGURE AST and parsing
  - AST: `ConfigureQuery` with scope (SESSION/DATABASE/INSTANCE/SYSTEM), action (SET/RESET), key, value
  - Tokens: CONFIGURE, SYSTEM, INSTANCE, SESSION, RESET
  - Parser: `CONFIGURE <scope> SET <key> := <value>`, `CONFIGURE <scope> RESET <key>`, dotted keys
  - 8 unit tests: all 4 scopes, SET/RESET, dotted keys, invalid scope error
- [x] Phase 2: Compilation — config key resolution
  - CONFIGURE_KEY_MAP: 10 known Gel-to-PG key mappings (query_execution_timeout→statement_timeout, etc.)
  - SESSION scope → `SET LOCAL pgKey = value`, SYSTEM scope → `ALTER SYSTEM SET pgKey = value`
  - DATABASE/INSTANCE scope → `INSERT INTO disc_config ... ON CONFLICT DO UPDATE`
  - SESSION RESET → `RESET pgKey`, SYSTEM RESET → `ALTER SYSTEM RESET pgKey`
  - DATABASE/INSTANCE RESET → `DELETE FROM disc_config WHERE key = ... AND scope = ...`
  - Unknown keys pass through unchanged
  - 10 unit tests: each scope SET/RESET, key mapping, unknown key passthrough
- [x] Phase 3: Config persistence — disc_config table
  - Table schema: `(key TEXT PRIMARY KEY, value JSONB, scope TEXT, updated_at TIMESTAMPTZ)`
  - Upsert pattern with ON CONFLICT for idempotent SET operations
- [x] Phase 4: PG E2E tests (compiler/pg-stage38.test.ts)
  - SET LOCAL statement_timeout verification, RESET restores default, SET LOCAL work_mem, disc_config CREATE+UPSERT+DELETE

---

### Stage 39: Annotations DDL & Abstract Annotations

**Goal**: Surface schema annotations in introspection and support custom annotation types
**Success Criteria**: Annotations visible in DESCRIBE output and /schema endpoints; abstract annotations parseable
**Tests**: Introspection output, SDL parsing, PG E2E
**Status**: Complete

Annotations are already parsed and extracted by the differ (stored in PropertyDefinition/LinkDefinition). This stage surfaces them properly.

Tasks:
- [x] Phase 1: Introspection & Codegen — annotations in DESCRIBE TYPE output
  - `annotations` field on PropertyDescription, LinkDescription, TypeDescription in introspection.ts
  - `extractAnnotationMap()` helper in SchemaManager for SDL → Record<string, string>
  - Codegen: `@description` JSDoc tags from property/type annotations
  - 9 unit tests: 6 introspection + 3 codegen (annotations-stage39.test.ts)
- [x] Phase 2: Abstract annotation declarations & validation
  - SDL: `abstract annotation deprecated;` — custom annotation types beyond built-in `description`
  - Validator: BUILTIN_ANNOTATIONS set (description, title, deprecated), `abstractAnnotations` tracking in ValidationContext
  - `validateAnnotationUsage()` checks type/property/link annotation names against built-in set or declared abstracts
  - SchemaManager: `AbstractAnnotationDef` interface, abstract annotation extraction from module declarations
  - Fixed type-level annotation extraction (filter members, not top-level property)
  - 6 unit tests: parsing, validation (undeclared error, built-in pass, declared pass), SchemaManager extraction
- [x] Phase 3: PG E2E tests (compiler/pg-stage39.test.ts)
  - Schema with annotations → migrate → DESCRIBE TYPE → verify annotations in JSON output
  - Schema with @description → codegen → verify JSDoc output
  - Abstract annotation declaration + usage → migrate → DESCRIBE SCHEMA → verify

---

### Stage 40: Migration DDL Integration Verification

**Goal**: End-to-end migration verification for all schema features added in Tiers 1-3
**Success Criteria**: A comprehensive schema using all features round-trips through migrate → rollback → re-migrate
**Tests**: 14 PG E2E tests across 3 files
**Status**: Complete

(All individual DDL generators exist — this stage verifies they compose correctly)

Tasks:
- [x] Phase 1: Comprehensive migration test (migration/comprehensive.test.ts, 5 tests)
  - Full schema migration: multiple types, abstract types, constraints (exclusive, max_len_value, min_value, max_value, one_of), rewrite rules, multi-links, array properties, multiple inheritance
  - Data insertion: valid data + constraint violation rejection (max_len, min_value, max_value, exclusive, one_of)
  - Rewrite trigger verification: INSERT auto-sets created_at, UPDATE sets updated_at
  - Schema introspection: TypeDef completeness, inherited properties, parent type chains
  - Migration tracking: disc_migrations table records, getMigrationStatus() counts
- [x] Phase 2: Rollback verification (migration/comprehensive-rollback.test.ts, 4 tests)
  - Full rollback: create → verify → rollback → verify tables dropped + migration record removed
  - Incremental migration: base schema → add type with FK → verify both tables
  - Modify and re-migrate: add property → verify ALTER TABLE adds column preserving existing
  - Rollback-to specific point: 3 sequential migrations → rollback to first → verify state
- [x] Phase 3: Schema evolution scenarios (migration/schema-evolution.test.ts, 5 tests)
  - Add rewrite to existing type: verify trigger created, existing data intact, new inserts auto-set
  - Add property preserving data: new columns added, existing rows have NULL
  - Remove rewrite rule: verify PG trigger dropped
  - Add annotation: verify in introspection, table unchanged
  - Multiple inheritance: inherited columns from abstract parents, data insertion

---

### Stage 41: Complete Binary Protocol

**Goal**: Full compatibility with Gel's wire protocol for existing client libraries
**Success Criteria**: TCP binary protocol server with handshake, SCRAM auth, query execution, type descriptors
**Tests**: 135 tests across 7 test files
**Status**: Complete

Tasks:
- [x] Phase 1: Protocol message types — encode/decode all message types (protocol/buffer.ts, protocol/enums.ts, protocol/messages.ts)
  - BufferReader/BufferWriter: big-endian uint8/16/32/64, strings, UUIDs, length-prefixed bytes
  - All protocol enums: Cardinality, TransactionState, InputLanguage, OutputFormat, Capability, CompilationFlag, ErrorSeverity
  - 8 client message types: ClientHandshake, SASLInitialResponse, SASLResponse, Parse, Execute, Sync, Flush, Terminate
  - 13 server message types: ServerHandshake, AuthenticationOK/SASL/SASLContinue/SASLFinal, ReadyForCommand, CommandComplete, CommandDataDescription, Data, ErrorResponse, ParameterStatus, ServerKeyData, LogMessage
  - splitWireMessage() for TCP stream framing
  - 70 tests (buffer.test.ts: 22, messages.test.ts: 48)
- [x] Phase 2: Type descriptors — binary serialization for all Disc types (protocol/typedesc.ts, protocol/type-codec.ts)
  - 11 descriptor tags: SET, OBJECT_SHAPE, BASE_SCALAR, ENUM, ARRAY, TUPLE, NAMED_TUPLE, RANGE, MULTI_RANGE, OBJECT_INPUT, COMPOUND
  - 21 well-known type UUIDs (std::str, int16/32/64, float32/64, bool, bytes, datetime, duration, uuid, bigint, decimal, json, cal types, memory)
  - encodeTypeDescriptors()/decodeTypeDescriptors() round-trip
  - buildResultDescriptors() from TypeDef + shape fields
  - encodeScalarValue()/decodeScalarValue() for 17 scalar types (Gel epoch for datetime)
  - encodeObjectValue() for object rows with shape descriptor
  - 75 tests (typedesc.test.ts: 29, type-codec.test.ts: 46)
- [x] Phase 3: Connection handshake — SCRAM-SHA-256 + TCP server (protocol/scram.ts, protocol/binary-server.ts)
  - Full SCRAM-SHA-256 via crypto.subtle (PBKDF2, HMAC-SHA-256, SHA-256, constant-time comparison)
  - BinaryProtocolServer: TCP listener with connection management
  - BinaryConnection: state machine (handshake→authenticating→ready→closed)
  - Handshake → optional SCRAM auth → ServerKeyData → ParameterStatus → ReadyForCommand
  - 29 tests (scram.test.ts: 16, binary-server.test.ts: 13)
- [x] Phase 4: Query execution flow (enhanced protocol/binary-server.ts)
  - Per-connection state tracking (module context, aliases, config)
  - Prepared statement cache (Map<string, CachedStatement>)
  - Output format handling: JSON, BINARY, JSON_ELEMENTS, NONE
  - Error code mapping: 22 Gel error codes, mapErrorToGelCode() for all Disc error types
  - 21 tests (query-execution.test.ts)
- [x] Phase 5: Server integration + wire-level tests
  - BinaryProtocolServer wired into DiscServer (binaryPort option in ServerConfig)
  - CLI: --binary-port flag for disc serve
  - 10 wire-level integration tests (wire-integration.test.ts): handshake, Execute, multi-query, error recovery, SCRAM auth, Parse+Execute, Terminate, DESCRIBE, DiscServer integration

---

## Tier 4: Completeness & Polish

### Stage 42: Full-Text Search (ext::fts)

**Goal**: Built-in full-text search extension using PostgreSQL tsvector/tsquery
**Success Criteria**: FTS index on properties, `fts::search()` function in EdgeQL
**Tests**: Extension registration, index creation, search compilation, PG E2E
**Status**: Complete

Tasks:
- [x] FTS extension module (ext-fts/): types.ts, index-builder.ts, extension.ts, mod.ts
  - FtsIndexConfig with columns, weights (A/B/C/D), language, custom index name
  - generateFtsColumn(): ALTER TABLE ADD COLUMN fts_vector tsvector GENERATED ALWAYS STORED
  - generateFtsIndex(): CREATE INDEX USING GIN on fts_vector
  - FtsExtension extends BaseExtension (no PG extension needed — tsvector built-in)
- [x] Built-in functions: fts::search → fts_vector @@ plainto_tsquery, fts::rank → ts_rank
  - Special compilation in compileFunctionCall() for fts_search and fts_rank
  - Default language "english", configurable per extension instance
- [x] 35 unit tests (ext-fts/fts.test.ts) + 5 PG E2E tests (ext-fts/pg-integration.test.ts)

---

### Stage 43: bytes_get_bit & Remaining Function Gaps

**Goal**: Complete all remaining built-in function gaps
**Success Criteria**: All Gel standard library functions supported
**Tests**: 26 unit + 12 PG E2E tests
**Status**: Complete

Tasks:
- [x] bytes_get_bit → GET_BIT, bytes_to_str → CONVERT_FROM
- [x] uuid_generate_v1mc → gen_random_uuid() (PG 16 has no v1mc)
- [x] math_power → POWER, math_log10 → LOG(10, $1), math_log2 → LOG(2, $1)
- [x] Verified 20+ functions already existed from prior stages (str_lower/upper/title, re_match/replace/test, math_sqrt/ln, datetime_of_transaction/statement, json_typeof/array_unpack/object_unpack, etc.)
- [x] 26 unit tests (compiler/stage43-functions.test.ts) + 12 PG E2E (compiler/pg-stage43.test.ts)

---

### Stage 44: GraphQL Extension (ext::graphql)

**Goal**: Auto-generate GraphQL schema from SDL and serve GraphQL queries
**Success Criteria**: GraphQL introspection works, basic CRUD queries execute
**Tests**: 36 unit + 4 PG E2E tests
**Status**: Complete

Tasks:
- [x] GraphQL extension module (ext-graphql/): types.ts, schema-generator.ts, query-translator.ts, extension.ts, mod.ts
  - SCALAR_TYPE_MAP: EdgeQL→GraphQL type mapping (str→String, uuid→ID, int64→String, etc.)
  - generateGraphQLSchema(): custom scalars, enum types, object types, Query+Mutation types, input types
  - generateGraphQLTypes(): structured GraphQLType[] from Schema
- [x] Query translation: simplified recursive descent GraphQL parser
  - parseGraphQLQuery(): query/mutation, operation names, arguments, nested selections, aliases, literals
  - translateToEdgeQL(): SELECT with shape+filter, INSERT, UPDATE SET, DELETE, LIMIT/OFFSET
- [x] Routes: POST /graphql (execute), GET /graphql (playground), GET /graphql/schema (SDL)
  - Query depth checking for safety (configurable maxDepth)
  - TRON-themed HTML playground
- [x] 36 unit tests (ext-graphql/graphql.test.ts) + 4 PG E2E tests (ext-graphql/pg-graphql.test.ts)

---

## Dependency Graph

```
Stage 25 (Constraints) ──────────────────────┐
Stage 26 (Cal Types) ───────────────┐        │
Stage 27 (Functions) ───────────────┤        │
Stage 28 (Indexing/Slicing) ────────┤        │
Stage 29 (Multiple Inheritance) ────┤        │
                                    ├── Tier 1 Complete ✅
                                    │
Stage 31 (Triggers) ────────────────┤
Stage 32 (Rewrites) ────────────────┤
Stage 33 (Aliases) ─────────────────┤
Stage 34 (Range Types) ─────────────┤
Stage 35 (SDL Features) ────────────┤
                                    ├── Tier 2 Complete ✅
                                    │
Stage 36 (Globals) ────────────────┐│ ✅
Stage 37 (Operators + EXPLAIN) ────┤│ ✅
Stage 38 (CONFIGURE) ─────────────┐││ ✅
Stage 39 (Annotations DDL) ───────┤││ ✅
Stage 40 (Migration Verify) ──────┤││ ✅
                                   │├── Tier 3 Complete ✅
Stage 41 (Binary Protocol) ───────┤│ ✅
                                   ││
                                   └┴── Tier 3 Complete ✅
                                    │
Stage 42 (Full-Text Search) ───────┤ ✅
Stage 43 (Remaining Functions) ────┤ ✅
Stage 44 (GraphQL Extension) ──────┤ ✅
                                    └── Tier 4 Complete ✅
```

All 4 tiers complete. 2056 tests passing, 0 failures. Stages within a tier were mostly independent and parallelized where possible.

---

_Gap analysis: `thoughts/shared/plans/2026-03-19-gel-parity-gap-analysis.md`_
_Previous phases (1-24) are documented in handoffs: `thoughts/shared/handoffs/disc-database/`_
