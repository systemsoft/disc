# Codegen Recon (Phase 0)

> Recon for the language-neutral codegen IR + Rust query-file SDK effort.
> No code changes. This document anchors every downstream phase in the **real**
> wire format and the **real** state of codegen in this repo, not a guessed one.
>
> **Status:** awaiting human sign-off (Phase 0 gate).

---

## TL;DR — three findings that change the plan

1. **There is no existing TS *query-file* codegen.** The whole `codegen/`
   directory is **schema-driven**: SDL → interfaces, insert/update/filter types,
   query-*builder* classes, typed client. Nothing reads a `.disc` *query* file,
   runs Parse/Describe, and emits a typed wrapper function. There are no
   `<query>.query.ts` emitters, no cardinality-aware return narrowing, and no
   golden fixtures for any of that.
   → **Phase 3's "correctness oracle" does not exist.** Its acceptance gate
   ("output diffs clean against the *current* codegen's output") cannot be met
   as written, because there is no current query-file output to diff against.
   See [Implications](#implications-for-the-plan).

2. **The descriptor layer is split in two, and they disagree.**
   - `protocol/typedesc.ts` — clean, fully round-trippable encoder/decoder with
     a `DescriptorTag` enum and a `TypeDescriptor` discriminated union. Refers to
     nested types **by UUID**. This is the natural structured IR anchor — **but it
     is not what the live server puts on the wire.**
   - `protocol/binary-server.ts` — separate hand-rolled "v2" encoders that refer
     to nested codecs **by position index**, matching what upstream Gel
     Python/JS clients expect. **This is wire truth.**

   Their tag numbers diverge past `BASE_SCALAR` (see [§1.1](#11-descriptor-tags--kinds)).

3. **The live Describe path hard-codes cardinality to `ONE`.** The
   schema-aware cardinality mapping (`required`/`multi` → One/AtMostOne/Many)
   exists only in `typedesc.ts buildResultDescriptors`, which the server does
   **not** call. So the descriptor that actually reaches a client today loses the
   exact cardinality signal Phase 2's IR is supposed to carry. This must be fixed
   (or sourced elsewhere) before a Rust emitter can honor `One→T` / `AtMostOne→Option<T>` / `Many→Vec<T>`.

---

## Part A — Binary type-descriptor wire format & Parse/Describe flow

### A.0 Protocol version & provenance

- Protocol **v2.0** — `protocol/enums.ts:150` (`PROTOCOL_MAJOR_VERSION = 2`,
  `PROTOCOL_MINOR_VERSION = 0`). Decoder tolerates the v3.0 `inputLanguage`
  field (`protocol/messages.ts:496`).
- ALPN string `"edgedb-binary"` (`protocol/binary-server.ts:959`).
- Values "match the Gel/EdgeDB binary protocol specification"
  (`protocol/enums.ts:7`). Vendored upstream reference tree lives at
  `reference-gel/` if a canonical diff is needed.

### A.1 Where Parse / Describe live

**Framing layer (message codecs):**
- `protocol/parser.ts` — `ProtocolParser`. `parseParseMessage` (295–328),
  `parseExecuteMessage` (330–373); inner `MessageReader` (475–530) for BE reads.
- `protocol/messages.ts` — `CommandDataDescriptionMsg` (185–193);
  `encodeCommandDataDescription` (631–646) / `decodeCommandDataDescription`
  (807–827). This message carries both descriptor blobs
  (`inputTypedescId/inputTypedesc/outputTypedescId/outputTypedesc`).
- Command bytes: Parse = `0x50` `'P'`, Execute = `0x4f` `'O'`
  (`protocol/enums.ts:17`).

**Server Describe producer (the real flow):** `protocol/binary-server.ts`
- `handleParse` (1416–1480): parses state, checks `stmtCache` by `commandText`,
  on miss calls `buildDescriptors(...)`, caches, emits `CommandDataDescription`.
- `handleExecute` (1482+): re-sends the descriptor only on id mismatch
  (`uuidsEqual`, 546–556) to dodge an upstream Python-client assertion.
- `buildDescriptors` (1703–1736): the core. Parses EdgeQL, then
  `collectParameters` (333–375) → input params; `inferOutputShape` (385–452) →
  output shape; `buildInputDescriptor` (505–543) / `buildOutputDescriptor`
  (719–767) → descriptor blobs.

### A.1.1 Descriptor tags / kinds

Canonical structured enum — `protocol/typedesc.ts:27` (`DescriptorTag`):

| Name | Value | Decoded in typedesc.ts? |
|---|---|---|
| `SET` | `0x00` | yes |
| `OBJECT_SHAPE` | `0x01` | yes |
| `BASE_SCALAR` | `0x02` | yes |
| `ENUM` | `0x03` | yes |
| `ARRAY` | `0x04` | yes |
| `TUPLE` | `0x05` | yes |
| `NAMED_TUPLE` | `0x06` | yes |
| `RANGE` | `0x07` | yes |
| `OBJECT_INPUT` | `0x08` | declared, **not** decoded |
| `COMPOUND` | `0x09` | declared, **not** decoded |
| `MULTI_RANGE` | `0x0a` | yes |
| `TYPE_ANNOTATION` | `0xff` | declared, **not** decoded |

Wire-truth tags actually emitted by `binary-server.ts` (`CTYPE_*`):
`CTYPE_BASE_SCALAR = 2`, `CTYPE_SHAPE = 1` (output object shape),
`CTYPE_INPUT_SHAPE = 8`, `CTYPE_NAMEDTUPLE = 5`.

⚠️ **Tag mismatch.** `binary-server.ts` uses `CTYPE_NAMEDTUPLE = 5` (the upstream
Gel value), but `typedesc.ts` assigns `TUPLE = 5` / `NAMED_TUPLE = 6`. Only
`SET=0`, `SHAPE/OBJECT_SHAPE=1`, `BASE_SCALAR=2`, `INPUT_SHAPE=8` coincide. **Pick
one canonical tag table for the IR** — the wire (upstream Gel) numbering is the
safe choice.

### A.1.2 Per-descriptor wire layouts

Structured form (`typedesc.ts`, UUID-referencing):

- **BASE_SCALAR**: `[u8 tag][16 id]`
- **SET**: `[u8 tag][16 id][16 elementTypeId]`
- **OBJECT_SHAPE**: `[u8 tag][16 id][u16 elemCount]`, per element
  `[u32 flags][u8 cardinality][u32 nameLen+name][16 typeId]`
- **ENUM**: `[u8 tag][16 id][u16 count]` then `[u32 name…]` members
- **ARRAY**: `[u8 tag][16 id][16 elementTypeId][u16 dimensions]` then
  `dimensions × u32` lower-bounds
- **TUPLE**: `[u8 tag][16 id][u16 count]` then `[16 elementTypeId]*`
- **NAMED_TUPLE**: `[u8 tag][16 id][u16 count]`, per element
  `[u32 nameLen+name][16 typeId]`
- **RANGE / MULTI_RANGE**: `[u8 tag][16 id][16 elementTypeId]`

Wire-truth form (`binary-server.ts`, position-referencing v2; doc at lines
196–209):

- **CTYPE_BASE_SCALAR (2)**: `[u8 t][16 tid]`
- **CTYPE_INPUT_SHAPE (8)**: `[u8 t][16 tid][u16 els]`, per el
  `[u32 flags][u8 cardinality][u32 nameLen+name][u16 pos]`
- **CTYPE_SHAPE (1)** (`encodeShapeV2`): `[u8 t][16 tid][u8 is_compound=0]
  [u16 ephemeral_free_objects=0][u16 els]`, per el
  `[u32 flags=0][u8 cardinality][u32 nameLen+name][u16 pos][u16 source_type_pos=0]`
- **CTYPE_NAMEDTUPLE (5)** (`encodeSystemConfigValue`):
  `[u8 t][16 tid][u32 nameLen+name][u8 is_shape=0][u16 ancestor_count=0][u16 els]`,
  per el `[u32 nameLen+name][u16 pos]`

The block is a flat concat of `[u32 len][descriptor]` records. The **root id** in
the `CommandDataDescription` header is the **last** descriptor's UUID
(`packTypedescBlock`, typedesc.ts:257).

### A.1.3 Cardinality

`protocol/enums.ts:64` (`Cardinality`), one `u8` per shape element, ASCII codes:

| Name | Byte | char |
|---|---|---|
| `NO_RESULT` (Empty) | `0x6e` | `'n'` |
| `AT_MOST_ONE` | `0x6f` | `'o'` |
| `ONE` | `0x41` | `'A'` |
| `MANY` | `0x6d` | `'m'` |
| `AT_LEAST_ONE` | `0x4d` | `'M'` |

Schema→cardinality mapping (`typedesc.ts buildResultDescriptors`, 553/579):
property `required ? ONE : AT_MOST_ONE`; link `multi ? MANY : (required ? ONE :
AT_MOST_ONE)`. ⚠️ **The live builders hard-code `0x41` (ONE) for every element**
(`binary-server.ts:528, 755`). Message-level `resultCardinality` is a `u8`
defaulting to `MANY` in `handleParse` (1431).

### A.1.4 Scalar identification (well-known UUIDs)

`typedesc.ts:48` (`WELL_KNOWN_ENTRIES`), reverse `UUID_TO_TYPE`, aliases
`SHORT_NAME_MAP`, resolver `resolveWellKnownType`. Second hard-coded copy in
`type-codec.ts resolveTypeNameFromId` (400–429). All ids
`00000000-0000-0000-0000-0000000001XX`:

| Type | suffix | Type | suffix |
|---|---|---|---|
| `std::uuid` | `0100` | `cal::local_datetime` | `010b` |
| `std::str` | `0101` | `cal::local_date` | `010c` |
| `std::bytes` | `0102` | `cal::local_time` | `010d` |
| `std::int16` | `0103` | `std::duration` | `010e` |
| `std::int32` | `0104` | `std::json` | `010f` |
| `std::int64` | `0105` | `std::bigint` | `0110` |
| `std::float32` | `0106` | `cal::relative_duration` | `0111` |
| `std::float64` | `0107` | `cal::date_duration` | `0112` |
| `std::decimal` | `0108` | `std::memory`/`cfg::memory` | `0130` |
| `std::bool` | `0109` | | |
| `std::datetime` | `010a` | | |

Value codecs (`type-codec.ts`): `encodeScalarValue` (52–196) /
`decodeScalarValue` (209–295) dispatch on short name. Wire rules: big-endian; Gel
epoch 2000-01-01 (`GEL_EPOCH_OFFSET_US = 946684800000000n`); datetime/local_datetime
= int64 µs; local_date = int32 days; local_time/duration = int64 µs; json =
`0x01` version byte + UTF-8; bigint/decimal = PostgreSQL numeric wire format
(base-10000 groups, sign `0x4000`, dscale). ⚠️ **enum/range/multirange/tuple have
descriptor support but no value codec** — `decodeScalarValue` default branch
throws "Unsupported scalar type". A Rust codec layer will hit this same wall;
flag for Phase 4.

### A.1.5 Nested object shapes; flags

`ObjectShapeElement` (typedesc.ts:139): `{ flags: u32, cardinality: u8, name,
typeId: 16-byte UUID }`. Flag bits (`ShapeElementFlags`, 499):
`IMPLICIT = 1<<0`, `LINK_PROPERTY = 1<<1`, `LINK = 1<<2`. Property vs link split
in `buildShapeForType` (542–618): properties → scalar (IMPLICIT if default);
links → LINK flag + recursively-built nested ObjectShape for the target,
falling back to a bare `uuid` scalar when no schema/target. Live v2 path nests by
`pos` + `source_type_pos`; live `inferOutputShape` currently produces **only flat
scalar fields** (no link recursion yet).

### A.1.6 Input params vs output shapes

- **Input params:** `collectParameters` (333–375) walks AST for `TypeCast` over
  `Parameter` (`<int64>$x`), strips `$`, dedups, records `{name, edgeqlType}`.
  `buildInputDescriptor` emits one BASE_SCALAR per scalar then a **`CTYPE_SHAPE`**
  (not INPUT_SHAPE) referencing by `pos`, cardinality hard-coded ONE. Comment
  535–538: upstream Python client raises `NotImplementedError` on a sparse
  (INPUT_SHAPE) codec, so a regular SHAPE is used even for args.
- **Output shapes:** `inferOutputShape` (385–452): INSERT/UPDATE/DELETE →
  `{id: uuid}`; bare-scalar SELECT → single `isScalar` field via
  `detectBareScalarType` (294–327); shaped SELECT → walk `shape.elements`,
  resolve each field's type from schema `TypeDef.properties`, default unknown to
  `uuid`. `buildOutputDescriptor` emits a single BASE_SCALAR for scalar results
  (no Object wrapper, comment 722–726), else BASE_SCALAR-per-type + one SHAPE.
- **Arg decode at Execute:** `decodeArgs` (578–611):
  `[i32 elem_count][per field: u32 reserved=0, i32 elem_len (-1=NULL), bytes]`;
  `elem_count` must equal `params.length`.

### A.1.7 Structured IR types the decoder produces

All in `protocol/typedesc.ts:128–198`: `BaseScalarDescriptor`, `SetDescriptor`,
`ObjectShapeElement`/`ObjectShapeDescriptor`, `EnumDescriptor`, `ArrayDescriptor`,
`TupleDescriptor`, `NamedTupleDescriptor`, `RangeDescriptor`,
`MultiRangeDescriptor`, and the `TypeDescriptor` discriminated union (189–198,
discriminated on `tag`). **This union is the natural anchor for the
language-neutral IR.** Live-path lightweight structs in `binary-server.ts`:
`ShapeElementV2 {name, pos, cardinality}`, `ParamInfo {name, edgeqlType}`,
`OutputField {name, edgeqlType}`, `OutputShape {typeName, fields[], isScalar?}`.

---

## Part B — Existing TS codegen output shape

### B.0 What actually exists: schema codegen only

`disc codegen` → `cli/main.ts:881` → `commands.codegen` (`cli/commands.ts:125`):
resolves SDL files (`--schema` / `--schema-dir`, default `./dbschema`), parses to
`Module[]`, `SchemaManager.modulesToSchema(...)` → compiler `Schema`, builds
`CodegenConfig`, `Codegen.generateTypeScript(schema, config)` (`codegen/mod.ts:57`),
extracts embedded SDK, `writeGeneratedFiles` to `./dbschema/disc-client`.

`TypeScriptGenerator.generate()` (`codegen/typescript-generator.ts:40`) emits
exactly four files: `types.ts`, `queries.ts` (builder classes), `client.ts`,
`index.ts`. **No per-query files.** The `--no-queries` flag toggles the query
*builder classes*, not query files — a naming collision to keep in mind.

### B.0.1 Real generated output (sample: `Nickel/api/dbschema/disc-client`)

A live consuming repo confirms the above. Its `.disc` files (`api.disc`,
`logger.disc`, `default.disc`) are **SDL schema** (`module … { type … }`), not
query files. The generated client is four files — `interfaces.ts`, `queries.ts`,
`client.ts`, `index.ts` (note: on-disk `interfaces.ts`, not the source
generator's `types.ts` — consistent with the **binary-baked/materialized SDK**
being a separate copy from source codegen).

Two things the real output proves:

**(1) Cardinality is decided by CRUD-method convention, never by a descriptor.**
The generated builder has fixed method→cardinality mappings:

```ts
// disc-client/queries.ts (generated)
async select(shape?: string): Promise<Types.api.PersonalKey[]> { …            // Many   → T[]
  return await this.client.query<Types.api.PersonalKey[]>(query); }
async selectById(id: string, shape?: string): Promise<Types.api.PersonalKey | null> { …  // AtMostOne → T | null
  const results = await this.client.query<Types.api.PersonalKey[]>(query, { id });
  return results[0] || null; }                                               // manual narrowing
async insert(data: Types.api.PersonalKeyInsert): Promise<Types.api.PersonalKey> { … }    // One → T
async count(condition?: string, …): Promise<number> { … }
```

Every method funnels through the **single generic** `client.query<T>(queryString,
vars)`; cardinality is baked into the template, not read from the wire. The
binary descriptor's cardinality byte is **never consulted** anywhere in codegen.

**(2) Scalars come from the schema interface, not Parse/Describe.** Enums →
string unions; `created: Date`, `id: string`, etc., emitted from the SDL type:

```ts
// disc-client/interfaces.ts (generated)
export namespace $default {
  export type AccountStatus = "BANNED" | "GOOD" | "LURKER" | … ;
  export interface BaseRecord { id: string; created: Date; updated: Date; }
}
```

EdgeQL type casts are stored as a static `_typeCasts` / `_typeInfo` map on the
builder (`{ created: "<datetime>", scope: "<Scope>", owner: "<uuid>" }`) for
runtime filter compilation — again schema-derived, not descriptor-derived.

→ Reinforces the headline: **there is no descriptor→type path in the existing
codegen.** What exists is a schema-driven CRUD builder where cardinality is a
fixed property of *which method you call*. The IR-driven query-file emitter
(Phases 2–4) is net-new infrastructure with no prior output to diff against.

### B.1 Reusable building blocks for a future query-file codegen

| Need | Where it lives today | State |
|---|---|---|
| Decoded descriptor to walk | `protocol/typedesc.ts:128–198` (`ObjectShapeDescriptor` etc.) | exists; not wire-aligned (§A.1.1) |
| Cardinality enum | `protocol/enums.ts:64` | exists |
| **Cardinality → return-type mapping** | — | **does not exist; net-new** |
| Scalar → TS map | `codegen/types.ts:145` (`DEFAULT_TYPE_MAPPINGS`), driver `mapEdgeQLTypeToTypeScript` (`types.ts:354`) | exists; **schema-`required`-driven nullability, not cardinality**; **no `range`/`multirange`**; `decimal→number` lossy |
| Nested-shape emit pattern to mirror | `typescript-generator.ts:410` (`generateInterface`), `:520` (`generatePropertyDefinition`) | walks compiler `TypeDef`, **not** a query `ObjectShapeDescriptor` — needs a parallel walker |
| Runtime call target for a wrapper | `sdk/client.ts:235` `query<T>` (+ `queryRaw<T>` :266) | exists; **no `querySingle`/`queryRequiredSingle`** |
| Type naming | `typescript-generator.ts:1146` (`getTypeScriptTypeName`), `:1190` (`resolveTypeReference`) | exists |

Scalar→TS table (`codegen/types.ts:145–258`), abbreviated:
`str→string`, `bool→boolean`, `int16/int32→number`, `int64→bigint`,
`float32/float64→number`, `decimal→number` (lossy), `uuid→string`,
`datetime→Date`, `duration→string`, `bytes→Uint8Array`, `json→unknown`,
`cal::local_datetime→Date`, other `cal::*→string`. **No `range<…>`/`multirange<…>`
entries** despite `RangeDescriptor` existing in the protocol layer — a gap the IR
+ emitters must fill.

### B.2 Tests / fixtures

**No query-file codegen tests or golden fixtures exist.** Existing codegen tests
(`typescript-generator.test.ts`, `types.test.ts`, `mod.test.ts`) cover the SDL
schema generator only. Cardinality is exercised solely in the protocol layer
(`protocol/typedesc.test.ts`, `type-codec.test.ts`, `query-execution.test.ts`).

**Reference algorithm to port** (canonical descriptor→wrapper logic, not Disc
code): the vendored gel-py generator at
`tests/gel-compat/python/.venv/.../gel/codegen/generator.py` — `.edgeql` →
cardinality-aware typed Python wrappers. Worth reading before Phase 2/3.

### B.3 The seam where the IR slots in

Query-file codegen doesn't exist, so there is no current `descriptor → emit`
seam *for queries*. The seam the plan introduces sits between:

- **Producer (descriptor) side:** a new entry point that Parse/Describes a query
  string to obtain `ObjectShapeDescriptor`/`ObjectShapeElement` (+ input-arg
  descriptor), each element carrying `cardinality`.
- **IR:** the language-neutral nodes (Phase 1).
- **Emit side:** new functions modeled on `generateInterface` /
  `generatePropertyDefinition`, reusing the leaf `mapEdgeQLTypeToTypeScript` for
  scalars, plus **net-new** cardinality→type narrowing.

The existing schema-codegen seam (`Schema` → `TypeScriptGenerator.generate()` →
`generateInterface` → `mapEdgeQLTypeToTypeScript`) is the pattern to mirror, but
note it has **no intermediate representation** — the compiler `TypeDef` *is* its
IR and TS strings are emitted directly. The plan's IR is genuinely new
infrastructure, not a refactor of an existing boundary.

---

## Implications for the plan

1. **Phase 3 needs reframing.** Its premise ("re-implement the *existing* TS
   query-file codegen as an IR consumer; diff output clean against current
   codegen") has no referent. Two viable replacements for the correctness oracle:
   - **(a) Port-and-pin:** treat the gel-py generator (`generator.py`) as the
     reference algorithm, build the TS query-file emitter fresh on the IR, and
     pin its output with new golden fixtures (the oracle becomes the fixtures,
     authored once and human-reviewed).
   - **(b) Round-trip oracle:** prove IR losslessness by round-tripping
     descriptor → IR → TS-types and checking the generated types accept real
     query results from a live instance, rather than diffing against a prior
     emitter.
   Recommend (a) for byte-stable review + (b) as the runtime check. Either way,
   **Phase 3 builds the first TS query-file emitter; it does not reproduce an
   existing one.**

2. **Phase 2 depends on cardinality the wire doesn't currently carry.** The live
   Describe path hard-codes `ONE`. Before the IR can be trusted, either fix the
   live builders to emit true cardinality (port the `buildResultDescriptors`
   logic into `binary-server.ts`), or source cardinality from the EdgeQL
   semantic analysis directly. This is a real prerequisite task, not covered by
   the current phase list. **Without it, `AtMostOne→Option<T>` / `Many→Vec<T>`
   in Phase 4 are unreachable.**

3. **Two descriptor encoders → pick a canonical tag table.** The IR (Phase 1)
   should adopt the **upstream-Gel wire numbering**, and the frontend (Phase 2)
   should decode from the **wire-truth** form (`binary-server.ts` v2, positional)
   — not from `typedesc.ts`'s structured-but-non-wire form. `typedesc.ts`'s
   `TypeDescriptor` union remains a useful *shape* reference for the IR types.

4. **Scalar coverage gaps are shared across languages.** `range`/`multirange`
   have no value codec and no TS mapping today; `decimal` is lossy
   (`→number`). The IR must represent these faithfully even though both the
   current TS map and the value-codec layer are incomplete — otherwise every
   emitter inherits the gap. Flag `decimal`/`bigint`/`range` as the
   highest-risk scalars for the Phase 2 golden fixtures (as the plan already
   anticipates).

---

## Source index (verified file:line)

- Descriptor tags / structured IR union: `protocol/typedesc.ts:27, 128–198`
- Well-known scalar UUIDs: `protocol/typedesc.ts:48`
- Cardinality enum: `protocol/enums.ts:64`
- Protocol version: `protocol/enums.ts:150`
- Wire-truth v2 encoders + CTYPE tags: `protocol/binary-server.ts:121–243`
- Describe producer: `protocol/binary-server.ts:333–452, 505–543, 719–767, 1416–1736`
- Value codecs: `protocol/type-codec.ts:52–295, 400–665`
- CommandDataDescription message codec: `protocol/messages.ts:185–193, 631–646, 807–827`
- Schema codegen entry: `cli/commands.ts:125`, `codegen/mod.ts:57`
- TS emit: `codegen/typescript-generator.ts:40, 410, 520, 1146`
- Scalar→TS map: `codegen/types.ts:145–258, 354`
- Runtime query call: `sdk/client.ts:235`
- Reference algorithm (gel-py): `tests/gel-compat/python/.venv/.../gel/codegen/generator.py`
