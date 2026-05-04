# Gel client compatibility (P2-09)

Smoke tests that run the **upstream** `gel` Python and JS clients against
`disc serve --binary-port` to validate disc's Gel binary wire protocol
implementation against real client code, not just our own internal tests.

## Layout

```
tests/gel-compat/
├── fixture/                 # disc.toml + minimal SDL (one Item type)
│   ├── disc.toml
│   └── dbschema/default.disc
├── python/
│   ├── requirements.txt     # pulls `gel` from PyPI
│   ├── test_crud.py         # pytest: insert / select / update / delete
│   └── README.md
├── node/
│   ├── package.json         # pulls `gel` from npm
│   ├── test_crud.mjs        # node:test, mirrors the Python suite
│   └── README.md
├── run.sh                   # boot disc, run both suites, teardown
└── README.md                # this file
```

## What's exercised

For each language:

1. Connect (handshake → AuthenticationOK in passwordless mode)
2. `INSERT Item { name := <str>$name, count := <int32>$count }` returning id
3. `SELECT Item { id, name, count } FILTER .id = <uuid>$id`
4. `UPDATE Item FILTER .id = <uuid>$id SET { count := <int32>$new }` + re-select
5. `SELECT Item { id, name, count }` (multi-row)
6. `DELETE Item FILTER .id = <uuid>$id`
7. `querySingle` on empty result returns null/None (Cardinality.AT_MOST_ONE)
8. Scalar codec roundtrips for `str`, `int32`, `int64`, `bool`, `float64`,
   `uuid`, `datetime` via `SELECT <T>$x`.

## What's deliberately out of scope

- **The full upstream Gel test suite.** It depends on Gel-server-specific
  features that disc does not implement: stored procedures, transaction
  semantics, `ext::auth`, `ext::ai`, `pg_trgm`-backed `fts::` indexes, etc.
- **SCRAM auth.** Disc supports it; isolating "does the wire protocol
  work" from "does SCRAM work" lets a smoke failure point at one or the
  other, not both. The `--binary-port` flag without `--binary-password`
  uses the passwordless path.
- **Concurrency / pool stress.** Single-connection serial CRUD is enough
  to validate the message types the average client uses.

If smoke fails, file the gap as a separate issue rather than fixing it
inline. Adding test breadth happens after the harness is green.

## Run locally

```bash
bash tests/gel-compat/run.sh
```

Skips a language whose toolchain is missing — you can run only the Python
or only the Node side and the script still exits 0 on the side that ran.

## Run in CI

The `gel-compat` job in `.github/workflows/ci.yml` runs `run.sh` on
ubuntu-latest with PostgreSQL cached the same way the e2e job does.
All six previously identified gaps are now closed and the full 14-test
matrix is green for both Python and Node clients.

## Known compat gaps (current state)

All six protocol gaps closed. Full 14-test matrix is green for both
upstream Gel clients (Python `gel` and JS `gel`).

1. **`system_config` ParameterStatus** — disc now emits a typedesc-prefixed
   NamedTuple `(session_idle_timeout: duration)`.
2. **`StateDataDescription` message** — disc now emits an empty SparseObject
   state codec at handshake.
3. **Protocol v2 vs v3 field shift** — `inputLanguage` removed from
   Parse/Execute wire format (v3.0+ field; disc speaks v2.0).
4. **CommandDataDescription typedesc bytes** — disc now parses each query
   with the EdgeQL parser, walks the AST for parameters and output shape,
   and emits valid v2 `CTYPE_BASE_SCALAR` + `CTYPE_SHAPE` descriptors
   (using position-referenced subcodecs as v2 requires). Names are
   stripped of the leading `$` since clients pass kwargs without it.
5. **Data message payload — fix path A applied.** disc now decodes the
   client's argument blob using the input typedesc, runs the query
   through the same compiler + connection pool the HTTP path uses, and
   re-encodes each result row as a Gel binary Object payload
   (`[u32 elem-count][per-field: u32 reserved][i32 len][bytes]`) using
   per-scalar codecs in `protocol/scalar-codecs.ts`. Three subtle
   landmines were fixed alongside:
     - **Compiler param indexing.** `compileParameter` mapped every
       named parameter (`$name`, `$count`) to `$1` because
       `parseInt("$name") || 1` collapses to 1. The compiler now walks
       the query AST in first-seen order and assigns each name a
       distinct PG positional index, with the binary executor passing
       the same map so bind values line up.
     - **One Data per row, not one Data with N elements.** The Python
       client's `parse_data_messages` skips exactly 6 bytes per Data
       message and decodes the rest as a single Object — bundling rows
       silently truncates results to one. JS has the same shape.
     - **Execute does NOT send ReadyForCommand.** RFC is the response
       to Sync. Sending it from both `handleExecute` and `handleSync`
       (real clients always pair Execute + Sync) leaves a stale RFC in
       the buffer that the next query consumes as its first message,
       short-circuiting the read loop and surfacing as alternating
       null/row results from sequential `query_single` calls.
   - Reference: `tests/gel-compat/node/node_modules/gel/dist/codecs/object.js:128`
     for the JS Object decode loop;
     `tests/gel-compat/python/.venv/lib/python*/site-packages/gel/protocol/codecs/object.pyx:152`
     for the Python equivalent.

6. **Scalar-only SELECT shape mismatch — closed.** `SELECT <bool>$x`,
   `SELECT <int64>$x`, etc. — any query whose top-level result is a
   bare scalar (no `Item { … }` shape) used to come back as
   `Object{id := None}` because `buildDescriptors` always emitted a
   `CTYPE_SHAPE` (Object). `inferOutputShape` now detects bare-scalar
   top-level expressions (TypeCast over a scalar type, scalar literals)
   and flags the OutputShape with `isScalar: true`;
   `buildOutputDescriptor` emits a single `CTYPE_BASE_SCALAR` (the
   scalar's well-known tid is the descriptor root), and
   `encodeRowAsScalar` writes the raw scalar bytes into the Data frame
   with no Object element-count prefix and no per-field
   reserved/length wrapper. Per-scalar bytes still come from
   `protocol/scalar-codecs.ts`.

   Files: `protocol/binary-server.ts` (`detectBareScalarType`,
   `inferOutputShape`, `buildOutputDescriptor`, `encodeRowAsScalar`).
