# Disc Database — Implementation Plan

> Last Updated: 2026-03-19
> Status: Gel Parity — Tiers 1-3
> Gap Analysis: `thoughts/shared/plans/2026-03-19-gel-parity-gap-analysis.md`

## Completed Work (Phases 1-24)

All core database integration and production infrastructure is complete. 1365 tests passing.

- Phases 1-9: Core execution, PG integration, CLI, auth, access policies, caching, production hardening
- Phases 10-15: Advanced queries, extensions, client SDK, codegen, CLI docs
- Phases 16-19: Deployment tooling, production E2E tests
- Phases 20-24: Advanced expressions, junction tables, polymorphism, multi-database, introspection

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
**Status**: Not Started

Tasks:
- [ ] Add alias AST node: name, expression (EdgeQL query)
- [ ] Update SDL parser for alias syntax:
  ```
  alias ActiveUsers := (select User filter .active = true)
  ```
- [ ] Resolve alias references during query compilation (inline the expression as a CTE)
- [ ] Migration differ: detect alias add/remove/change
- [ ] PG E2E: select from alias, filter alias, use alias in WITH

---

### Stage 34: Range & Multirange Types

**Goal**: Support `range<T>` and `multirange<T>` throughout the stack
**Success Criteria**: Range properties work in SDL, queries, and PG execution
**Tests**: SDL parsing, DDL, query compilation, PG E2E
**Status**: Not Started

Tasks:
- [ ] Add range/multirange to type system with parameterized type support
- [ ] Map to PG types: `range<int32>` → `int4range`, `range<int64>` → `int8range`, `range<float64>` → `numrange`, `range<datetime>` → `tstzrange`, `range<cal::local_date>` → `daterange`, `range<cal::local_datetime>` → `tsrange`
- [ ] Add range construction: `range(lower, upper)` → PG range constructor
- [ ] Add range functions: `range_get_lower`, `range_get_upper`, `range_is_empty`, `range_contains`, `range_overlaps`, `contains` (element in range)
- [ ] Multirange equivalents
- [ ] Range operators: `@>`, `<@`, `&&`, `<<`, `>>`, `&<`, `&>`, `-|-`
- [ ] PG E2E: range creation, containment, overlap queries

---

### Stage 35: Remaining SDL Features

**Goal**: Implement remaining SDL features for complex schemas
**Success Criteria**: All features parse, validate, and generate correct DDL
**Tests**: SDL parsing, DDL, PG E2E
**Status**: Not Started

Tasks:
- [ ] Collection type properties in SDL: `property tags: array<str>`, `property coords: tuple<float64, float64>`
  - Map to PG array types and composite types
- [ ] `on target delete set empty` — clear link when target is deleted
  - DDL: `ON DELETE SET NULL` for the FK column
- [ ] `on source delete` — source-side deletion behavior
  - Implement via PG trigger or CASCADE on reverse FK
- [ ] Link inheritance — links extending abstract links
  - Validate link type compatibility, merge link properties
- [ ] Abstract polymorphic types in function signatures (`anytype`, `anyscalar`, etc.)
  - Used for generic function overloading resolution

---

## Tier 3: Blocks Client Library Compatibility

### Stage 36: Operators — Bitwise & Regex

**Goal**: Support all Gel operators
**Success Criteria**: Operators parse and compile to correct PG SQL
**Tests**: Parser tests, compilation tests, PG E2E
**Status**: Not Started

Tasks:
- [ ] Bitwise operators in EdgeQL parser: `&`, `|`, `^`, `<<`, `>>`, `~` (unary NOT)
- [ ] Compile bitwise to PG: direct mapping (same operators)
- [ ] Regex match operators: `~` (match), `!~` (not match), `~*` (case-insensitive match), `!~*`
- [ ] PG E2E: bitwise math, regex filtering

---

### Stage 37: CONFIGURE Queries

**Goal**: Support runtime configuration via EdgeQL
**Success Criteria**: `CONFIGURE` queries modify PG settings and Disc config
**Tests**: Parser, compilation, PG E2E
**Status**: Not Started

Tasks:
- [ ] Add CONFIGURE AST nodes: scope (SYSTEM/INSTANCE/DATABASE), action (SET/RESET)
- [ ] Parse `CONFIGURE SYSTEM SET <key> := <value>`
- [ ] Map config keys to PG `SET` commands or Disc config table
- [ ] `CONFIGURE DATABASE SET` → database-scoped config
- [ ] Persist config in `disc_config` table
- [ ] PG E2E: set and query config values

---

### Stage 38: Complete Binary Protocol

**Goal**: Full compatibility with Gel's wire protocol for existing client libraries
**Success Criteria**: Official Gel TypeScript/Python client connects to Disc and executes queries
**Tests**: Protocol message encoding/decoding, client library integration tests
**Status**: Not Started

Tasks:
- [ ] Implement all Gel binary protocol message types (reference `reference-gel/edb/protocol/`)
- [ ] Type descriptor encoding/decoding for all types including cal, range, multirange
- [ ] SASL/SCRAM-SHA-256 authentication handshake
- [ ] State synchronization messages
- [ ] Prepared statement support
- [ ] Error message format compatibility
- [ ] Test with `gel-js` official TypeScript client
- [ ] Test with `gel-python` official Python client

---

### Stage 39: Migration DDL for New Schema Features

**Goal**: DDL generation and diffing for triggers, rewrites, aliases, new constraints
**Success Criteria**: Migrations correctly handle add/remove/modify of all new schema objects
**Tests**: Differ tests, DDL generation tests, PG E2E migration round-trips
**Status**: Not Started

(Tracked within each feature stage above — this stage covers any remaining integration gaps)

Tasks:
- [ ] Verify migration differ handles all new AST node types
- [ ] Verify DDL generator emits correct SQL for all new types
- [ ] Integration test: full schema with triggers, rewrites, aliases, constraints → migrate → verify PG state
- [ ] Rollback test: ensure all new DDL operations can be reversed

---

## Dependency Graph

```
Stage 25 (Constraints) ──────────────────────┐
Stage 26 (Cal Types) ───────────────┐        │
Stage 27 (Functions) ───────────────┤        │
Stage 28 (Indexing/Slicing) ────────┤        │
Stage 29 (Multiple Inheritance) ────┤        │
                                    ├── Tier 1 Complete
                                    │
Stage 31 (Triggers) ────────────────┤
Stage 32 (Rewrites) ────────────────┤
Stage 33 (Aliases) ─────────────────┤
Stage 34 (Range Types) ─────────────┤
Stage 35 (SDL Features) ────────────┤
                                    ├── Tier 2 Complete
                                    │
Stage 36 (Operators) ───────────────┤
Stage 37 (CONFIGURE) ───────────────┤
Stage 38 (Binary Protocol) ─────────┤   Depends on all type
Stage 39 (Migration DDL) ───────────┤   additions (T1-T7)
                                    └── Tier 3 Complete
```

Most stages within a tier are independent and can be parallelized. Stage 38 (Binary Protocol) depends on all type system additions being complete since the protocol must serialize all types.

---

_Gap analysis: `thoughts/shared/plans/2026-03-19-gel-parity-gap-analysis.md`_
_Previous phases (1-24) are documented in handoffs: `thoughts/shared/handoffs/disc-database/`_
