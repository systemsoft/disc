# Testing

Disc has a comprehensive test suite spanning the schema parser, EdgeQL compiler, migration engine, server protocol, auth, access policies, CLI, SDK, and the bundled-PostgreSQL machinery. This guide covers how to run the suite locally, how tests are organized, and how to author new tests in the patterns the codebase already uses.

For implementation-level notes (skip-discipline, mock-vs-real, env isolation), see also the in-repo [tests/TESTING.md](../tests/TESTING.md).

---

## Running the suite

The two main entry points are the non-PG suite (fast, runs in CI on every push) and the PG-backed suite (requires a running PostgreSQL and is gated behind `DISC_PG_AUTO=1`).

### Non-PG suite

```bash
deno task test
```

Runs every `*.test.ts` file under `schema/`, `compiler/`, `migration/`, `cli/`, `lib/`, `postgres/`, `server/`, `protocol/`, `auth/`, `access/`, `extensions/`, `sdk/`, `codegen/`, `edgeql/`, and `tests/`. PG-backed tests are gated through `tests/pg-test-harness.ts` and skip cleanly when no PostgreSQL is reachable.

Tip: run a single file by passing it directly:

```bash
deno test --allow-all --no-check schema/parser.test.ts
```

Filter by test name with `--filter`:

```bash
deno test --allow-all --no-check --filter "rejects empty email" auth/
```

### PG-backed suite

```bash
DISC_PG_AUTO=1 deno task test:pg
```

`DISC_PG_AUTO=1` tells the harness to auto-start a temp PostgreSQL on a random port (via `pg_ctl`) and tear it down at the end of the run. The harness searches for `pg_ctl` via `DISC_PG_BINARY_PATH`, Postgres.app, Homebrew, then `which pg_ctl`. To skip the auto-start and use a server you already have running, set `DATABASE_URL` instead.

PG-backed tests live alongside their non-PG siblings — for instance `auth/pg-integration.test.ts` runs against a real PG, while `auth/provider.test.ts` is in-memory.

### Coverage

CI uploads `coverage/lcov.info` on every push. To inspect locally:

```bash
genhtml coverage/lcov.info -o coverage-html
open coverage-html/index.html
```

---

## Test categories

Tests are classified by whether they need a running PostgreSQL instance and by which layer they exercise.

| Category            | Examples                                                            | Needs PG | Runs in CI     |
| ------------------- | ------------------------------------------------------------------- | -------- | -------------- |
| **Unit**            | `schema/parser.test.ts`, `edgeql/lexer.test.ts`                     | No       | Always         |
| **Compiler**        | `compiler/compiler.test.ts`, `compiler/polymorphic.test.ts`         | No       | Always         |
| **PG integration**  | `migration/schema-manager.test.ts`, `auth/pg-integration.test.ts`   | Yes      | DISC_PG_AUTO=1 |
| **Protocol**        | `protocol/binary-server.test.ts`, `server/edgeql-protocol.test.ts`  | No       | Always         |
| **End-to-end**      | `tests/production-e2e/*.test.ts`                                    | Yes      | Manual         |
| **Structural pins** | `tests/gel-divergence-pins.test.ts`, `tests/typecheck-pins.test.ts` | No       | Always         |
| **UI**              | `tests/ui-*.test.ts`                                                | No       | Always         |

Production e2e tests are not part of the default `deno task test` invocation — they take longer and exercise the full HTTP/binary stack against a live server. Run them explicitly:

```bash
DISC_PG_AUTO=1 deno test --allow-all --no-check tests/production-e2e/
```

---

## Authoring new tests

Disc follows test-driven development for new features and bug fixes:

1. Write the failing test first.
2. Run it and confirm it fails for the expected reason.
3. Write the minimal code to make it pass.
4. Refactor with the test as a safety net.

The patterns below are the conventions established across the codebase — match them when adding new tests.

### Naming

```typescript
Deno.test("rejects an empty email at registration", async () => {
  // ...
});
```

The name describes the behavior under test — not the function name, not the class name. Tests like `"register works"` or `"AuthProvider tests"` are anti-patterns; they bury the contract.

### One behavior per test

Each `Deno.test` block asserts one thing. If you find yourself writing `assert(a); assert(b); assert(c);` for unrelated checks, split the test. The convention across the codebase is one assertion per behavior — multiple `assert` calls are fine when they collectively prove a single contract (e.g., "the response has shape `{ ok: true, id: ... }`").

### Real code over mocks

The codebase prefers calling the real implementation with dependency injection over mocking. For example:

```typescript
// PREFERRED — call the real InitCommand with an injected failing PG manager
import { InitCommand } from "../cli/init.ts";

Deno.test("disc init surfaces PG download failures", async () => {
  const cmd = new InitCommand({
    pgManager: { ensure: () => Promise.reject(new Error("offline")) },
  });
  await assertRejects(() => cmd.execute([]), Error, "offline");
});
```

Older `cli/*.test.ts` files declare a module-local `mockInitCommand` that duplicates command logic. These are being phased out — see `cli/init.test.ts` for the current pattern (real `InitCommand` + injected dependencies).

### Real database, not stubs (PG-backed tests)

For PG-backed integration tests, hit a real PostgreSQL via `tests/pg-test-harness.ts`:

```typescript
import { canRunPgTests, withTestDatabase } from "../tests/pg-test-harness.ts";

Deno.test({
  name: "webauthn_challenges cascades on user delete",
  ignore: !canRunPgTests(),
  async fn() {
    await withTestDatabase(async (pool) => {
      // ... real INSERT, real DELETE, assert the cascade behavior ...
    });
  },
});
```

Mocking the database leads to drift: a mocked test passes, the real schema migrates wrong, and production breaks. Use the harness.

### Structural pins

When Disc's behavior structurally diverges from Gel — either because Disc never had Gel's bug, or because we ship a feature Gel doesn't — the test that protects the divergence is a **structural pin** in `tests/gel-divergence-pins.test.ts`. Pins read the source code and assert invariants like "this file uses `Deno.listenTls`, never `Deno.serve`":

```typescript
Deno.test("Gel #4172: binary protocol server uses TCP/TLS, not HTTP", async () => {
  const src = await Deno.readTextFile(
    new URL("../protocol/binary-server.ts", import.meta.url),
  );
  assert(src.includes("Deno.listenTls"));
  assert(!src.includes("Deno.serve"));
});
```

A future PR that "modernizes" the binary server to `Deno.serve` will trip the pin and have to deliberately update the divergence record. See [`docs/future-triage.md`](future-triage.md) for the full Gel-issue map and `tests/gel-divergence-pins.test.ts` for the running list of pins.

---

## Env isolation

CLI tests that mutate `Deno.env` MUST use `EnvMock` from `tests/test-utils.ts`. Setting `Deno.env.set` directly leaks across tests run in the same Deno process and causes order-dependent failures.

```typescript
import { EnvMock } from "../tests/test-utils.ts";

Deno.test("DATABASE_URL flows through to ServerConfig", () => {
  const env = new EnvMock();
  env.set("DATABASE_URL", "postgres://test");
  try {
    // ... test body ...
  } finally {
    env.restore();
  }
});
```

The same discipline applies to any test that touches process-level state: working directory (`Deno.chdir`), CWD-relative file reads, or the global signal handlers. Restore in `finally`.

---

## PG-backed tests

PG-backed tests live in the same module as their non-PG siblings and are gated through `tests/pg-test-harness.ts`:

- `canRunPgTests()` — returns `true` when a usable PG is reachable. Wrap the test in `Deno.test({ name, ignore: !canRunPgTests(), fn })`.
- `withTestDatabase(async (pool) => …)` — provisions a fresh database on a fresh schema, runs the body, and tears down. The pool injected into the body is a real `ConnectionPool`; statements run against real PG.
- `setupTestSchema(pool, sdl)` — applies SDL to the test database via the real `SchemaManager` so tests exercise the same migration path users hit.

### Skip discipline

Every intentional skip in the repo uses `ignore: !canRunPgTests()` so an audit can compare the count to the awaiting-PG count:

```bash
grep -rn 'ignore: !canRunPgTests' --include='*.test.ts' | wc -l
grep -rn 'ignore: true' --include='*.test.ts'  # should match permanent skips only
```

`ignore: true` without the harness guard is a **permanent skip** — fix the test or delete it. Don't leave rotting ignores in the suite.

### Cleanup

`withTestDatabase` already drops the database at the end. Tests that open additional connections, file handles, or background tasks must close them in `finally` blocks. Deno's strict resource-leak detection catches anything left open and fails the test.

---

## Common pitfalls

- **`server.start()` returns `finished`, not done.** It returns a promise that resolves when the server stops. In tests, fire-and-forget with `void server.start()` (or capture the promise and `await` only at teardown).
- **Response body leak in HTTP tests.** Deno fails tests that don't consume response bodies. If you only check status, call `await response.body?.cancel()`.
- **Type errors in test files block `deno check`.** The full project (including `*.test.ts` files) passes `deno check` on every commit. Use `requireAuthResponse(result)` and `if (!parseResult.ok) throw parseResult.error;` to narrow `LoginResult` and `Result<T, E>` unions before accessing fields.
- **Cross-test order dependence.** Deno's test runner doesn't guarantee order across files. Don't rely on a previous test having created data — use `withTestDatabase` for isolation, or seed inside the test.

---

## Adding a new test category

If you find yourself writing tests that don't fit any existing category — for instance, fuzzing the EdgeQL parser, or running a long-running soak test — discuss before adding new top-level directories. The current shape (slice-by-slice with PG-gated peers) keeps the mental model simple.
