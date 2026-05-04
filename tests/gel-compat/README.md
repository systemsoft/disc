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

The harness landed in working order: TLS+ALPN, handshake, and SCRAM
optional-skip all work end-to-end against both upstream clients. Two
gaps remain before any CRUD test goes green:

1. **`system_config` ParameterStatus is omitted.** Upstream clients decode
   it as a typedesc-prefixed record (UUID + typedesc + encoded data). Disc
   does not yet generate that encoding. The JS client falls back to
   defaults when the message is absent and continues. The Python client
   reads `system_config.session_idle_timeout` directly without a None
   check and crashes — so Python smoke is fully gated on this.
   - Fix: generate a NamedTuple typedesc with at least `session_idle_timeout`
     (duration), encode with the existing typedesc + duration codecs in
     `protocol/typedesc.ts` and `protocol/type-codec.ts`, send as
     `ParameterStatus { name: "system_config", value: <encoded> }`.

2. **Server-side message parser hits "Buffer underflow" on real client
   Execute messages.** The internal wire-integration tests pass, so this
   is a difference between disc's own constructed Execute frames and the
   ones the upstream JS client sends. Likely an off-by-N in field decoding
   or a header field disc isn't expecting. Surface symptom: client
   receives `InternalServerError: Buffer underflow: need <N> bytes at
   position <p>, but only <m> bytes remain` on first non-handshake query.
   - Reproducer: bash `tests/gel-compat/run.sh` → first JS test (INSERT).

When a fix lands for either gap, the corresponding tests in this suite
flip to green automatically — that's the point of the harness.
