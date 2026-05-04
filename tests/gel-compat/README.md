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
The job is `continue-on-error: true` while compatibility gaps are being
worked through (see "Known compat gaps" below). Each green test that
appears in the workflow log is a real validation win.

## Known compat gaps (current state)

Three protocol gaps have been closed since the harness first ran:

1. **`system_config` ParameterStatus** — disc now emits a typedesc-prefixed
   NamedTuple `(session_idle_timeout: duration)`. Both clients decode it
   and access `.session_idle_timeout` without a NoneType crash.
2. **`StateDataDescription` message** — disc now emits an empty
   SparseObject state codec right after the ParameterStatus block. Without
   it, the Python client `assert self.state_codec is not None` fired
   mid-query inside `encode_parse_params`.
3. **Protocol v2 vs v3 field shift** — `inputLanguage` is a v3.0+ field;
   disc speaks v2.0 but was reading/writing it on Parse/Execute. Removing
   it from the wire format fixed a cascading 1-byte misalignment that
   surfaced as the infamous `Buffer underflow: need 14921 bytes at
   position 33` on the client.

After these fixes both clients complete handshake, send Parse + Execute,
and disc replies with `CommandDataDescription` + `Data`. **Remaining gap:**

4. **Disc emits empty input/output type descriptors in
   CommandDataDescription.** Symptom: Python `RuntimeError: cannot not
   build codec; empty type desc`; JS `InternalClientError: could not
   build a codec`. The compiler tracks result shape but the binary
   protocol layer doesn't translate that into v2 typedesc bytes.
   - Fix: in `protocol/binary-server.ts` near the `prepareDescriptors`
     helper, walk the EdgeQL query's compiled output type and emit a
     CTYPE_OBJECT (=10) shape with one element per field; for queries
     with parameters, emit a CTYPE_INPUT_SHAPE (=8). The wire shape both
     clients expect is in
     `tests/gel-compat/python/.venv/lib/python*/site-packages/gel/protocol/codecs/codecs.pyx:209-249`
     and `tests/gel-compat/node/node_modules/gel/dist/codecs/registry.js:132-164`.

When this lands the CRUD smoke flips fully green.
