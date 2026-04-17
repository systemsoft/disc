# Testing notes

## Running

```bash
# Non-PG tests (fast; runs in CI on every push/PR)
deno test --allow-all --no-check \
  schema/ compiler/ migration/ cli/ lib/ postgres/ \
  server/ protocol/ auth/ access/ extensions/ sdk/ codegen/ edgeql/

# Full suite including PG integration tests
DISC_PG_AUTO=1 deno task test:pg
```

## Test categories

Tests are classified by whether they need a running PostgreSQL instance:

- **Unit** — no external dependencies. Always run.
- **PG-integration** — require a running PG. Gated with
  `ignore: !canRunPgTests()` from `tests/pg-test-harness.ts`. The
  harness auto-detects `pg_ctl` via `DISC_PG_BINARY_PATH`,
  Postgres.app, Homebrew, or `which pg_ctl`, and boots a temp
  instance on a random port.

## Labeling skipped tests (P2-34)

All intentional skips in this repo use `ignore: !canRunPgTests()` so
`grep -rn 'ignore: !canRunPgTests' | wc -l` matches the "awaiting-pg"
count. Any `ignore: true` without that guard is a **permanent skip**
and should either be fixed or removed — not left rotting.

```bash
# Audit script: list unconditional skips
grep -rn 'ignore: true' --include='*.test.ts'
```

## Env isolation (P2-32)

CLI tests that mutate `Deno.env` MUST use `EnvMock` from
`tests/test-utils.ts`:

```ts
import { EnvMock } from "../tests/test-utils.ts";

Deno.test("my env test", () => {
  const env = new EnvMock();
  env.set("DATABASE_URL", "postgres://test");
  try {
    // ... test body ...
  } finally {
    env.restore();
  }
});
```

Setting `Deno.env.set()` directly leaks across tests run in the same
Deno process and causes order-dependent failures.

## Mock vs real (P2-33)

Some `cli/*.test.ts` files historically declared a module-local
`mockInitCommand` (etc.) that duplicated the real command logic.
These are being phased out — new tests call the real `InitCommand`
with dependency injection (e.g. inject a failing `PostgresManager`
to force error paths). See the `pg-fail-test` case in
`cli/init.test.ts` for the current pattern.

## Coverage

CI uploads `coverage/lcov.info` on every push. Download from the
workflow run's Artifacts to inspect locally with lcov:

```bash
genhtml coverage/lcov.info -o coverage-html
open coverage-html/index.html
```
