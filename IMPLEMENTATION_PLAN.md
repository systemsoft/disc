# Disc Database — Implementation Plan

> Last Updated: 2026-03-19
> Status: Gel Parity — Tiers 1-2 Complete, Tier 3 In Progress
> Gap Analysis: `thoughts/shared/plans/2026-03-19-gel-parity-gap-analysis.md`

## Completed Work (Phases 1-36)

All core database integration, production infrastructure, and advanced SDL features are complete. **1690 tests passing.**

- Phases 1-9: Core execution, PG integration, CLI, auth, access policies, caching, production hardening
- Phases 10-15: Advanced queries, extensions, client SDK, codegen, CLI docs
- Phases 16-19: Deployment tooling, production E2E tests
- Phases 20-24: Advanced expressions, junction tables, polymorphism, multi-database, introspection
- Stages 25-29: Constraints, cal types, standard library (88 functions), indexing/slicing, multiple inheritance
- Stages 31-35: Triggers, rewrites, aliases, range/multirange types, collection types, deletion policies, link inheritance, polymorphic types
- Stage 36: Globals (session variables) — GlobalDef, SET GLOBAL, access policy integration, PG session vars

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
**Tests**: Parser tests, compilation tests, PG E2E
**Status**: Not Started

Tasks:
- [ ] Phase 1: Bitwise operators in EdgeQL
  - Tokens: `BITAND` (`&`), `BITOR` (`|`), `BITXOR` (`^`), `LSHIFT` (`<<`), `RSHIFT` (`>>`), `BITNOT` (`~` unary)
  - Lexer: disambiguate `&` (bitwise AND) from `&&` (overlaps) — `&&` already handled for ranges
  - Parser: new precedence level for bitwise ops (between comparison and arithmetic)
  - Compiler: direct PG mapping (same operators)
  - Unit tests: each operator, precedence, nested expressions (8 tests)
- [ ] Phase 2: Regex operators in EdgeQL
  - Tokens: `REGEX_MATCH` (`~`), `REGEX_NOT_MATCH` (`!~`), `REGEX_IMATCH` (`~*`), `REGEX_NOT_IMATCH` (`!~*`)
  - Lexer: disambiguate `~` (regex match / bitwise NOT) by context — unary = BITNOT, binary = REGEX_MATCH
  - Parser: binary operators at comparison precedence level
  - Compiler: direct PG mapping (same operators)
  - Unit tests: match, not match, case-insensitive variants (6 tests)
- [ ] Phase 3: EXPLAIN queries
  - EdgeQL AST: `ExplainQuery` node with `query` field and options (analyze, buffers, format)
  - Parser: `EXPLAIN [ANALYZE] [BUFFERS] <query>` syntax
  - Compiler: wrap compiled SQL in `EXPLAIN (ANALYZE, FORMAT JSON) ...`
  - Integration with existing explain-cache (lib/explain-cache.ts)
  - Unit tests: basic EXPLAIN, EXPLAIN ANALYZE, format options (4 tests)
- [ ] Phase 4: PG E2E tests
  - Bitwise: AND/OR/XOR/SHIFT on integers
  - Regex: filter with pattern match, case-insensitive match
  - EXPLAIN: verify plan structure returned, EXPLAIN ANALYZE timing

---

### Stage 38: CONFIGURE Queries

**Goal**: Support runtime configuration via EdgeQL
**Success Criteria**: `CONFIGURE` queries modify PG settings and Disc config
**Tests**: Parser, compilation, PG E2E
**Status**: Not Started

Tasks:
- [ ] Phase 1: Parser — CONFIGURE AST and parsing
  - AST nodes: `ConfigureQuery` with scope (SYSTEM/INSTANCE/DATABASE/SESSION), action (SET/RESET/INSERT/REMOVE)
  - Tokens: CONFIGURE, SYSTEM, INSTANCE, SESSION (DATABASE already exists)
  - Parser: `CONFIGURE <scope> SET <key> := <value>`, `CONFIGURE <scope> RESET <key>`
  - Unit tests: parse all 4 scopes, SET/RESET actions, value expressions (8 tests)
- [ ] Phase 2: Compilation — config key resolution
  - Config registry: map Gel config keys to PG settings or Disc internal config
  - SESSION scope → `SET LOCAL <key> = <value>` (transaction-scoped)
  - DATABASE scope → persist in `disc_config` table
  - SYSTEM scope → persist in `disc_system_config` table + `ALTER SYSTEM SET`
  - Known keys: `query_execution_timeout`, `listen_addresses`, `shared_buffers`, etc.
  - Unit tests: each scope compiles to correct SQL, unknown key error (6 tests)
- [ ] Phase 3: Config persistence and retrieval
  - `disc_config` table: `(key TEXT PRIMARY KEY, value JSONB, scope TEXT, updated_at TIMESTAMPTZ)`
  - MigrationTracker: create config table alongside migrations table
  - Server startup: load DATABASE/SYSTEM config and apply to connections
  - Unit tests: persist/retrieve/reset config values (6 tests)
- [ ] Phase 4: PG E2E tests
  - SET SESSION config, verify via query
  - SET DATABASE config, restart, verify persisted
  - RESET config key, verify default restored

---

### Stage 39: Annotations DDL & Abstract Annotations

**Goal**: Surface schema annotations in introspection and support custom annotation types
**Success Criteria**: Annotations visible in DESCRIBE output and /schema endpoints; abstract annotations parseable
**Tests**: Introspection output, SDL parsing, PG E2E
**Status**: Not Started

Annotations are already parsed and extracted by the differ (stored in PropertyDefinition/LinkDefinition). This stage surfaces them properly.

Tasks:
- [ ] Phase 1: Introspection — annotations in DESCRIBE TYPE output
  - describeType(): include `annotations` field in JSON output (already in PropertyDefinition)
  - /schema/types/:name endpoint: return annotations in type description
  - Codegen: emit `@description` JSDoc tags from annotation values
  - Unit tests: annotations in DESCRIBE, /schema endpoint, codegen output (6 tests)
- [ ] Phase 2: Abstract annotation declarations
  - SDL: `abstract annotation deprecated;` — custom annotation types beyond built-in `description`
  - Validator: check annotation usage against declared abstract annotations
  - SchemaManager: collect abstract annotations from module declarations
  - Unit tests: abstract annotation parsing, validation, undeclared annotation error (4 tests)
- [ ] Phase 3: PG E2E tests
  - Schema with annotations → migrate → DESCRIBE TYPE → verify annotations in output
  - Custom abstract annotation → use on type → verify in introspection

---

### Stage 40: Migration DDL Integration Verification

**Goal**: End-to-end migration verification for all schema features added in Tiers 1-3
**Success Criteria**: A comprehensive schema using all features round-trips through migrate → rollback → re-migrate
**Tests**: Full-schema integration tests, rollback verification
**Status**: Not Started

(All individual DDL generators exist — this stage verifies they compose correctly)

Tasks:
- [ ] Phase 1: Comprehensive migration test
  - Create schema using: constraints, triggers, rewrites, aliases, ranges, collection types, deletion policies, link inheritance, multiple inheritance, globals, annotations
  - Migrate from empty → verify all PG objects created correctly
  - Verify data insertion respects all constraints, triggers, rewrites
  - 3-5 integration tests (migration/comprehensive.test.ts)
- [ ] Phase 2: Rollback verification
  - Migrate comprehensive schema → rollback → verify clean state
  - Migrate → modify (add/remove features) → migrate → verify incremental DDL
  - 3-5 rollback tests (migration/comprehensive-rollback.test.ts)
- [ ] Phase 3: Schema evolution scenarios
  - Add trigger to existing type, verify trigger created without data loss
  - Change constraint params, verify CHECK updated
  - Remove rewrite rule, verify trigger dropped
  - Convert single-link to multi-link, verify junction table created
  - 4-6 evolution tests (migration/schema-evolution.test.ts)

---

### Stage 41: Complete Binary Protocol

**Goal**: Full compatibility with Gel's wire protocol for existing client libraries
**Success Criteria**: Official Gel TypeScript client connects to Disc and executes basic queries
**Tests**: Protocol message encoding/decoding, client library integration tests
**Status**: Not Started

This is the largest remaining stage. Break into sub-phases.

Tasks:
- [ ] Phase 1: Protocol message types — encode/decode all message types
  - Reference: `reference-gel/edb/protocol/`
  - Client→Server: ClientHandshake, AuthenticationSASLResponse, Execute, Parse, DescribeStatement, Sync, Terminate
  - Server→Client: ServerHandshake, AuthenticationSASL, CommandComplete, Data, ReadyForCommand, ErrorResponse, ParameterStatus
  - Binary buffer reader/writer utilities
  - 20+ unit tests for message round-tripping
- [ ] Phase 2: Type descriptors — binary serialization for all Disc types
  - Scalar types: str, int16/32/64, float32/64, bool, bytes, datetime, duration, uuid, bigint, decimal, json
  - Cal types: local_date, local_time, local_datetime, relative_duration, date_duration
  - Collection types: array, tuple, named tuple, range, multirange
  - Object shapes: type descriptors for SELECT result shapes
  - 15+ unit tests for type descriptor encoding
- [ ] Phase 3: Connection handshake — SASL/SCRAM-SHA-256
  - SCRAM-SHA-256 implementation (or use existing Deno crypto)
  - ServerHandshake → AuthenticationSASL → AuthenticationSASLContinue → AuthenticationSASLFinal → ReadyForCommand
  - Parameter negotiation (protocol version, extensions)
  - 8+ tests for auth flow
- [ ] Phase 4: Query execution flow
  - Parse → DescribeStatement → Execute pipeline
  - Prepared statement cache
  - State sync (current database, module, globals)
  - Error serialization matching Gel error codes
  - 10+ tests for query execution
- [ ] Phase 5: Client library compatibility tests
  - Install `gel-js` (official TypeScript client), connect to Disc via binary protocol
  - Basic query execution: SELECT scalar, SELECT object with shape
  - INSERT/UPDATE/DELETE operations
  - Transaction support
  - 10+ integration tests

---

## Tier 4: Completeness & Polish

### Stage 42: Full-Text Search (ext::fts)

**Goal**: Built-in full-text search extension using PostgreSQL tsvector/tsquery
**Success Criteria**: FTS index on properties, `fts::search()` function in EdgeQL
**Tests**: Extension registration, index creation, search compilation, PG E2E
**Status**: Not Started

Tasks:
- [ ] FTS extension module (ext-fts/): Extension interface, types, index builder
- [ ] SDL: `index fts::index on (.title ++ ' ' ++ .body)` → GIN index on `tsvector`
- [ ] Built-in functions: `fts::search(type, query)` → `ts_query` / `ts_rank` compilation
- [ ] DDL: GIN index generation, tsvector column (generated always)
- [ ] PG E2E: index creation, search with ranking, language config

---

### Stage 43: bytes_get_bit & Remaining Function Gaps

**Goal**: Complete all remaining built-in function gaps
**Success Criteria**: All Gel standard library functions supported
**Tests**: Unit + PG E2E per function
**Status**: Not Started

Tasks:
- [ ] `bytes_get_bit` → `GET_BIT`
- [ ] `uuid_generate_v1mc` → `gen_random_uuid()` (map to v4, v1mc not available in modern PG)
- [ ] Any remaining function gaps discovered during client library testing
- [ ] Unit tests + PG E2E for each

---

### Stage 44: GraphQL Extension (ext::graphql)

**Goal**: Auto-generate GraphQL schema from SDL and serve GraphQL queries
**Success Criteria**: GraphQL introspection works, basic CRUD queries execute
**Tests**: Schema generation, query translation, PG E2E
**Status**: Not Started

Tasks:
- [ ] GraphQL extension module (ext-graphql/): schema generation from Disc types
- [ ] Type mapping: Object types → GraphQL types, links → connections, constraints → validation
- [ ] Query translation: GraphQL query → EdgeQL → SQL pipeline
- [ ] Mutation support: insert/update/delete via GraphQL mutations
- [ ] /graphql endpoint on server with playground UI
- [ ] Subscription support via WebSocket

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
Stage 37 (Operators + EXPLAIN) ────┤│
Stage 38 (CONFIGURE) ─────────────┐││
Stage 39 (Annotations DDL) ───────┤││
Stage 40 (Migration Verify) ──────┤││  Depends on 36-39
                                   │├── Tier 3
Stage 41 (Binary Protocol) ───────┤│   Depends on all type
                                   ││   additions (T1-T8)
                                   └┴── Tier 3 Complete
                                    │
Stage 42 (Full-Text Search) ───────┤
Stage 43 (Remaining Functions) ────┤
Stage 44 (GraphQL Extension) ──────┤
                                    └── Tier 4 Complete
```

Stages within a tier are mostly independent and can be parallelized. Stage 41 (Binary Protocol) depends on all type system additions. Stage 40 depends on 36-39 being complete.

---

_Gap analysis: `thoughts/shared/plans/2026-03-19-gel-parity-gap-analysis.md`_
_Previous phases (1-24) are documented in handoffs: `thoughts/shared/handoffs/disc-database/`_
