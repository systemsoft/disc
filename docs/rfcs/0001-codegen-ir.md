# RFC 0001 — Language-Neutral Codegen IR

> **Status:** Draft — Phase 1 (IR definition) awaiting human sign-off.
> **Supersedes:** the original inline "Language-Neutral Codegen IR + Rust Query-File SDK" plan.
> **Companion:** [`docs/codegen-recon.md`](../codegen-recon.md) (Phase 0 recon, approved).

## Goal

Make generating a typed client **trivial in any target language**: adding a
language must be "write one emitter," never "touch the analysis." A
language-neutral **intermediate representation (IR)** is the single contract
between schema analysis (frontends) and code emission (emitters).

We prove the IR is sound the only way that counts: **refactor the existing
default TypeScript query builder to be emitted from the IR**, and require its
output to match what ships today. The existing, shipping artifact is the
correctness oracle. Then add a **Rust** emitter as the second consumer to prove
the boundary actually generalizes.

```
                         ┌──────────────┐
  compiler Schema ──────▶│   Schema     │
  (SDL → TypeDef)        │   frontend   │──┐
                         └──────────────┘  │
                                           ▼
                                      ┌─────────┐      ┌── TS emitter   ─▶ interfaces.ts + queries.ts (oracle)
                                      │   IR    │─────▶├── Rust emitter ─▶ structs + builder (HTTP/JSON)
                                      └─────────┘      └── Go / Python  ─▶ (future, no frontend changes)
                                           ▲
  Parse/Describe   ──────┌──────────────┐  │
  (binary descriptor)    │  Descriptor  │──┘
                         │  frontend    │   (future: query-file SDKs)
                         └──────────────┘
```

The IR is the contract. Frontends produce it; every emitter consumes the same
nodes. Adding a language must never require touching a frontend.

## What recon changed about the original plan

(Full detail in `docs/codegen-recon.md`. Summary of the three load-bearing facts.)

1. **There is no existing query-file codegen.** All of `codegen/` is
   schema-driven: SDL → object interfaces, `Insert`/`Update`/`Filter` variants,
   CRUD query-builder classes, typed client. So the original plan's "diff
   IR-output against the existing query-file codegen" oracle had no referent.
   → **The schema-driven query builder is the oracle instead** — it exists,
   ships, and is exercised by real consumers (e.g. `Nickel/api/dbschema`).

2. **The shipping query builder never reads a binary descriptor.** Cardinality
   is fixed by CRUD-method convention (`select`→`T[]`, `selectById`→`T | null`,
   `insert`→`T`), and every call routes through one generic
   `client.query<T>(eql, vars)` over **HTTP/JSON to `/query`** (`sdk/client.ts`).
   → The primary frontend is **Schema → IR**, not descriptor → IR. The Rust
   emitter targets the same HTTP/JSON endpoint, so **Phase 4 needs no binary
   codec layer.**

3. **The live Describe path hard-codes cardinality to `ONE`.** Real
   `required`/`multi` → One/AtMostOne/Many logic lives only in
   `typedesc.ts buildResultDescriptors`, which the server never calls.
   → This only blocks the **descriptor** frontend (future query-file SDKs), not
   the schema-driven oracle. Folded in as **Phase 1.5** so wire cardinality is
   honest before any descriptor-driven work, but it is **not** on the critical
   path to the Rust query builder.

## The IR (the contract)

Two layers. Both are pure data — no language assumptions, no logic.

### Layer 1 — Type model

- **Scalar**: canonical kind (one of the well-known set — `str`, `bool`,
  `int16/32/64`, `float32/64`, `decimal`, `bigint`, `uuid`, `datetime`,
  `duration`, `local_datetime`, `local_date`, `local_time`, `relative_duration`,
  `date_duration`, `bytes`, `json`, `memory`), carrying its EdgeQL name and
  well-known UUID. The IR names the scalar **semantically**; mapping to a native
  type is the emitter's job.
- **Enum**: name, module, ordered members.
- **Collection**: `array<T>`, `tuple<...>`, named `tuple<a: T, ...>`,
  `range<T>`, `multirange<T>` — represented structurally over type refs.
- **Object type**: name, module, and `fields[]`, where each field carries the
  metadata an emitter needs without re-deriving it: `{ name, type (ref),
  cardinality, readonly, hasDefault, isLink, isComputed, isExclusive }`.

### Layer 2 — Operation model

- **Operation**: `{ name, kind, params[], output }`. `kind` ∈
  `select | selectById | filter | insert | update | delete | count | query`
  (`query` = a free-form query-file op, future).
- **Param**: `{ name, type (ref), cardinality, optional, hasDefault }`.
- **Output**: `{ type (ref to object shape / scalar / collection), cardinality }`.

### Cardinality

`Empty | AtMostOne | One | Many | AtLeastOne` — **wire-complete** (matches
`protocol/enums.ts`). The schema frontend only emits the first four;
`AtLeastOne` is reserved for the future descriptor frontend (a set proven
non-empty, e.g. `assert_exists`). Carrying it now keeps `Cardinality` — the
contract's most load-bearing type — stable when that frontend lands, at the cost
of one aliased match arm per schema emitter. Emitter mapping is fixed and
mechanical:

| Cardinality | TypeScript | Rust |
|---|---|---|
| `One` | `T` | `T` |
| `AtMostOne` | `T \| null` | `Option<T>` |
| `Many` | `T[]` | `Vec<T>` |
| `AtLeastOne` | `T[]` (aliases `Many` until refined) | `Vec<T>` (ditto) |
| `Empty` where `One` expected | generation-time error | generation-time error |

### Key design decision (for Phase 1 sign-off): denormalized shape variants

To hit "trivial across languages," the IR should **pre-derive** the
`Insert` / `Update` / `Filter` / `FilterVars` shapes as first-class IR shapes
(computed in the frontend, referencing the base object type), so each emitter is
a near-mechanical pretty-printer rather than re-implementing "Insert excludes
readonly/computed, makes defaulted fields optional" in every language.

- **Alternative considered:** keep the IR minimal (base type + field flags only)
  and let each emitter derive the variants. Rejected as the default because it
  pushes the same semantic logic into every language, which is exactly the
  duplication this effort exists to kill.
- **Recommendation:** denormalized variants in the IR; field flags retained so
  emitters can still make language-idiomatic choices. **This is the one boundary
  call I most want ratified at the Phase 1 gate.**

## Phases

Per-phase discipline (unchanged): at every boundary — (1) `deno test` green,
(2) the phase's acceptance gate met, (3) human has eyeballed the output — before
the next phase begins. TDD governs every code phase (test red → implement green →
refactor). **Phase 1 sign-off is mandatory and non-negotiable.**

### Phase 0 — Recon ✅ (done, approved)
`docs/codegen-recon.md`.

### Phase 1 — IR definition (human-gated) — `[ ]`
TypeScript types only, zero logic. Captures Layer 1 + Layer 2 + cardinality +
full scalar set + collections + the denormalized shape variants.
**Gate:** human reviews and signs off on the IR types, explicitly ratifying the
denormalized-variants decision above. *This checkpoint never gets skipped.*

### Phase 1.5 — Cardinality truth on the descriptor path — `[ ]`
Port `buildResultDescriptors`' `required`/`multi` → cardinality logic into the
live `binary-server.ts` builders so Describe emits real cardinality instead of
hardcoded `ONE`.
**Gate:** descriptor round-trip fixtures show correct `One`/`AtMostOne`/`Many`/
`Empty` per field.
**Scope note:** prerequisite for the **descriptor** frontend (future query-file
SDKs); **independent of** the schema-frontend oracle path. Can proceed in
parallel with Phases 2–4.

### Phase 2 — Schema frontend (`Schema → IR`) — `[ ]`
Transform the compiler `Schema`/`TypeDef` into IR: the type model + the standard
CRUD operation set per object type + the denormalized shape variants.
**Gate:** golden IR fixtures for representative schemas — object types with
links, enums, the gnarly scalars (`decimal`, `bigint`, `uuid`, `datetime`,
ranges), required vs optional vs multi, readonly/defaulted/computed fields.
Fixtures round-trip (schema in → expected IR out).

### Phase 3 — TS emitter on the IR + **refactor the default query builder** — `[ ]`
Re-implement today's TS codegen as an IR consumer and **replace** the current
direct-from-`TypeDef` emission. The generated `interfaces.ts`, `queries.ts`,
`client.ts`, `index.ts` are now produced from IR nodes.
**Gate:** output diffs **clean** against current codegen output for the fixture
schemas (modulo intentional formatting); the existing `codegen/*.test.ts` suite
plus a regenerate-and-diff check against a captured baseline (e.g. the
`Nickel/api/dbschema/disc-client` output) stays green.
**Why this is the oracle:** if the IR-driven emitter reproduces today's shipping
output, the IR is proven lossless before any other language depends on it.

### Phase 4 — Rust emitter — `[x]` (4a compiles ✅, 4b round-trip ✅)
Second IR consumer: `codegen/emit-rust.ts` emits a Rust schema-driven query
builder — structs (`serde::Deserialize`), enums, insert/update shapes, per-object
query builders, and a std-only blocking HTTP/JSON `DiscClient` over
`std::net::TcpStream` (no reqwest/tokio — builds offline). Cardinality per the
table above; scalars → JSON-friendly Rust types (uuid/datetime/decimal/bigint →
`String`, json → `serde_json::Value`); modules → Rust `mod`s.

**4a gate met:** real `cargo build --offline` passes for the multi-module fixture
**and** the real 30-type Nickel schema (`codegen/emit-rust.test.ts`).

**4b gate met:** generated Rust round-trips against a live Disc instance.
Verified manually (server setup is too heavy for CI, like the cross-repo Nickel
check): `disc init` a one-type project, migrate, `disc serve`, emit the Rust
client, and a `cargo run --offline` binary that calls the generated
`insert(WidgetInsert{...})` and `select()` — both return typed structs from the
live `/query` endpoint (`i32`, `Option<bool>`, etc.), assertions pass. The
committed automated proof is the `cargo build --offline` compiles gate
(`emit-rust.test.ts`); the round-trip is documented manual verification.

**What Rust revealed about the IR (the point of a second emitter):** the IR's
honest One→`T` object-link cardinality produces by-value reference cycles
(`Channel`↔`Customer`) that are infinite-sized in Rust. TS never hits this
(structural typing). The fix — `Box<T>` for single object links — is the
emitter's job, not an IR gap; it's the clearest evidence the IR faithfully
encodes cardinality rather than papering over it. Also surfaced: the source
`Schema` multi-keys types (bare + qualified), so a module can list a type twice
in the IR — consumers must dedupe (handled in the emitter, not the frozen
frontend).

### Future (not this effort)
- **Descriptor frontend** (`Parse/Describe → IR`) for typed **query-file** SDKs;
  depends on Phase 1.5. Then per-language query-file emitters.
- **Go / Python** emitters — each a Phase-4-style task, one emitter, no frontend
  changes. (A native query-file SDK additionally needs a per-language protocol
  client + codec layer; that cost is real and per-language but does not touch the
  IR.)

## Explicitly out of scope

- The TS query **builder fluent API** (conditional/mapped-type inference) — a
  TS-only luxury that doesn't generalize. The CRUD *methods* on the generated
  builder classes (`select`/`insert`/…) **are** in scope; the type-level fluent
  chaining is not.
- New query surface syntax; protocol/client changes beyond reading descriptors.

## Decisions ratified at the Phase 1 gate (2026-06-30)

1. **Denormalized shape variants in the IR.** The frontend pre-derives
   `insert` / `update` / `filter` shapes per object type; emitters pretty-print
   them directly and never re-derive "Insert excludes readonly/computed,
   defaulted fields optional."
2. **The IR carries the filterable field set + operand types.** Operator
   spelling (`eq`/`like`/`in`/…) stays the emitter's concern. `FilterVars` is an
   **explicit** IR node (`FilterVarsShape`) — the flat, all-optional variables
   bag for raw-string filtering — not left to the emitter to re-derive.
3. **Modules are first-class IR namespaces.** The IR root groups by module
   (`default`, `api`, `logger`); every type definition and reference carries its
   module. Emitters map a module to a TS `namespace` / Rust `mod`.

→ IR types implemented in `codegen/ir.ts` (Phase 1, types only). Awaiting
final sign-off on the concrete types before Phase 2.

### Contract enrichment (2026-06-30, during Phase 3)

The Phase 3 byte-identical oracle proved the initial IR was lossy: it dropped
schema data the generated JSDoc/structure depends on. Per sign-off, the
contract was extended additively (no existing consumer breaks):

- `ObjectType`: `tableName` (backing table, not derivable), `parentTypes`
  (`extending …` — structural), `description?`.
- `Field`: `constraints: { name, args }[]` (full set, e.g. `max_length(255)`;
  `isExclusive` retained as a derived convenience flag), `description?`.

Closing the swap surfaced three more lossy spots (caught by the computed/
collection fixture and a byte-for-byte run against the real Nickel schema):

- `Field.sourceType` — the raw `edgeqlType` spelling (e.g. `array<tuple<...>>`,
  `cal::local_datetime`, `auto`), echoed verbatim in JSDoc docType. (Closes the
  deferred item above.)
- `Field.computedExpr` — the computed property's EdgeQL source, fed to
  `inferComputedTupleFields` to rebuild typed computed-tuple filters and
  `_typeInfo.computed`.
- `CodegenIR.multiModule` — whether any type declares a module (even `default`);
  distinguishes a single explicit `default` module (namespaced `interfaces.ts`)
  from no modules (flat `types.ts`). The earlier emitter reconstructed this from
  module count and got it wrong for an all-`default` schema.

### Phase 3 complete (2026-06-30)

The production codegen path (`codegen/mod.ts` `generateTypeScript`) now routes
schema → IR → emit (`schemaToIR` + `emitTypeScript`); `TypeScriptGenerator` is
retained only as the byte-identical oracle. Proven byte-identical on three
in-repo fixtures (flat, multi-module, computed+collection, module-qualified
target) **and** on the real 30-type Nickel schema. Full codegen suite: 137
green.
