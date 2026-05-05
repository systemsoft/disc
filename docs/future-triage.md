# FUTURE.md Triage

> Status of every Gel issue tracked in `FUTURE.md` against Disc's roadmap.
> Generated: 2026-05-05

## Methodology

For each candidate, cross-check against (a) Disc codebase state and (b) upstream Gel issue state. The intersection gives the action:

| Disc → | DONE | PARTIAL | NOT-DONE |
|---|---|---|---|
| **Gel open** | SKIP (we're ahead) | BUILD (fix the gap) | BUILD (lead upstream) |
| **Gel closed-completed** | SKIP | BUILD (port the merged PR) | BUILD (port the merged PR) |
| **Gel closed-not_planned** | SKIP | DROP (or justify divergence) | DROP (Gel rejected for a reason — re-evaluate before reviving) |

Two issues fall into a fifth bucket: Disc deliberately diverges from Gel's `not_planned` decision because the threat/UX model is different (#7341 CAPTCHA, #7482 disable-signup-per-provider).

## Summary

- **DONE**: ~50 high-relevance items already shipped in disc (cross-referenced with `git log`)
- **BUILD**: ~60 high-relevance items pickable, sorted by leverage below
- **SKIP**: ~120 high-relevance items not applicable to Disc (Gel-internal, Gel-Python, Gel-cloud-specific, or Disc-already-handled by virtue of being a fresh TS rewrite)
- **DROP**: 2 high-relevance items upstream rejected (#7482, #7341 — already documented in prior audit; #7341 was actually re-implemented in Disc as opt-in CAPTCHA)
- **Medium (789) and Low (1,676)**: handled via category-level rules below; no per-issue enumeration

## High Relevance (score 8-10) — full enumeration

### DONE — already shipped in Disc

| # | Title | Shipped in |
|---|-------|------------|
| #496 | Password authentication + basic auth infra | `auth/provider.ts` |
| #528 | JWT for HTTP ports | `auth/middleware.ts` |
| #1486 | `edgedb wipe` / `restore --force` | `767afb7` |
| #1485 | Restore does not restore databases | `767afb7` |
| #1838 | Safe/unsafe migration classification | `migration/engine.ts` |
| #1002 | Dump/restore from stdin/stdout | `767afb7` |
| #720 | Backup options | `767afb7` |
| #2078 | Migration timestamps | `migration/tracker.ts` (created_at column) |
| #3567 | File storage & upload | `lib/file-storage/`, `7e1961f` |
| #4277 | TLS certificate hot-reload | `server/tls-reload.ts` |
| #4278 | SIGHUP config reload | `ae7e124` |
| #4300 | Migration rollback / reset | `cli/main.ts` rollback flags |
| #4854 | Liveness/readiness endpoints | `server/http.ts` `/health/*` |
| #5053 | Helm Charts | `f9f438b` |
| #5065 | Cryptography & hashing functions | `a067c97` (std::* crypto stdlib) |
| #5524 | Server-wide read-only mode | `ServerConfig.readOnly` + AST classifier |
| #6345 | Auth for GraphQL/HTTP | `server/http.ts` gateAuth + `config.requireAuth` |
| #6502 | Password reset bypassing email verification | `9bdcf6f` |
| #6725 | WebAuthn / passkey | `auth/webauthn.ts`, `6416c5f` |
| #6726 | LinkedIn OAuth | `5548f79` |
| #6727 | Facebook OAuth | `5548f79` |
| #6728 | X/Twitter OAuth | `5548f79` |
| #6908 | Zitadel / generic OIDC | `ext-oauth/discovery.ts` |
| #7006 | Validate auth config / fail closed | `5b21b8d` |
| #7341 | CAPTCHA in auth UI | `314634b` (re-introduced opt-in despite Gel "not_planned") |
| #7367 | Magic Code Support | `314634b` |
| #7370 | Keycloak OAuth Provider | `5548f79` |
| #7415 | Generic OpenID Connect provider | `ext-oauth/providers.ts` |
| #7468 | Wildcard subdomains in redirect URLs | `92168fd` |
| #7484 | Auth lifecycle webhooks | `auth/webhooks.ts`, `47e6f38` |
| #7490 | Migration progress visibility | `b7bedeb` + `767afb7` |
| #7557 | OIDC profile information | `88ee80c` |
| #7752 | OAuth `extraAuthorizeParams` | `eb93633` |
| #8186 | OTC suite (TOTP + magic link + recovery) | `4bc3929`, `7a1f92b`, `4b30aca` |
| #8224 | Email auth requires SMTP | `314634b` |
| #8533 | SMTP cert validation toggle | `314634b` |
| #8750 | Anonymous / guest identity | `auth/provider.ts` `loginAnonymous`, `4fe83db` |
| #8773 | Migration `order` / `applied_order` | `179ac31` |
| #8841 | Auth flow state preservation | `88ee80c` |
| #8950 | Auth login error / PKCE cookie path | `88ee80c` |
| #9137 | Timing side-channel in secret comparison | `protocol/scram.ts:172-181` |
| #3465 | Single-command create+apply migration | `8065541` |
| #6085 | Migration merge conflicts guidance | `dcab128` (docs) |
| #718 | GraphQL rate limiting | `8065541` (docs) |
| #6094 | Programmatic migration tooling guide | `migration/` exports + docs |

(Approx. 50 items — many ride on a single commit; cross-referenced via `git log --oneline`.)

### BUILD — sorted by leverage (security/correctness > UX > infra; S < M < L effort)

| # | Title | Category | Why pickable | Effort |
|---|-------|----------|--------------|--------|
| #5988 | Mark config variables as `secret` | auth | Drives introspection-safe handling; needed once UI exposes config | S |
| #6444 | Expose `secret` flag in introspection | auth, db | Pairs with #5988 — UI needs to mask secret fields | S |
| #6655 | Configurable CORS `Access-Control-Allow-Origin` | auth, devtools | One-day server.ts patch; prerequisite for non-localhost UI use | S |
| #5234 | Instance-level config via CLI args / env | devtools | Most flags already env-mapped; finish the matrix | S |
| #4547 | `DISC_SERVER_TLS_CERT_ENV` / `_KEY_ENV` | auth | Dev-only nicety, ~15 LoC in `server/tls.ts` | S |
| #4408 | Pre-commit + CI hooks | devtools | Project-side: add `.pre-commit-config.yaml` calling `deno fmt`/`deno lint` | S |
| #6648 | Document error codes & meanings | sdk-client | Generate from `lib/errors.ts` enum + JSDoc | S |
| #930 | "Please file an issue" hint on ISE | devtools | Wrap `InternalServerError` constructor | S |
| #1218 | Fix `\d` REPL meta-command | cli | `cli/shell` — current introspection output is truncated | S |
| #1325 | Read configuration from local file | devtools | `disc.toml` already exists; expose more keys | S |
| #5709 | Refresh button in UI data viewer | devtools | UI-only; SvelteKit data viewer | S |
| #6205 | Prometheus metric for TLS cert expiry | devtools | One gauge in `server/metrics.ts` | S |
| #5405 | Prometheus gauge metrics report timestamps as values | devtools | Bug fix — verify our metrics don't have this | S |
| #6126 | Performance guide | docs | Write up indexing + EXPLAIN once `disc analyze` lands | S |
| #6096 | Production migration documentation | docs | Expand `docs/migrations.md` with rollback story | S |
| #1163 | EdgeQL cheat sheet | docs | One-page reference; we already have parser tests as examples | S |
| #4170 | Containerized local dev docs | docs | We have Helm; add `docker-compose.yml` for self-host | S |
| #6176 | docker-compose example | docs | Pairs with #4170 | S |
| #4239 | Secure TLS setup in deploy guides | docs | Expand `docs/production-deployment.md` | S |
| #4787 | Document undocumented config options | docs | Audit `lib/config.ts` against `docs/server.md` | S |
| #4943 | Document new features | docs | Generate from CHANGELOG | S |
| #1021 | Authentication is under documented | docs | Already partially in `docs/auth.md`; finish | S |
| #2647 | CLI verb-object regularity | cli | Audit `cli/main.ts` command surface; `disc db wipe` lands here | M |
| #1129 | Explicit superuser CLI command | cli, auth | `disc admin create-superuser` — wires into RBAC role registry | M |
| #1486 + escape-hatch | (already DONE for wipe) — also need backup-before-wipe gate | cli | Cherry on top | S |
| #1119 | Better error on `create role` | cli, auth | Hook into the RBAC API we shipped at `df92455` | S |
| #1030 | `-H` for hostname / `-h` for help | cli | Standard ergonomics fix | S |
| #6094 | Programmatic reimplementing migrations guide | docs, migrations | Expand exports surface + write guide | M |
| #6083 | Advanced migration workflows | docs | Branches, squashing, partial application | M |
| #6094 | (above) | | | |
| #4319 | Run migrations in IO process | migrations, perf | Engine perf; only matters at >1000-object schemas | M |
| #6697 | In-place major version upgrades | migration | Big — port pg_dump/pg_restore based path | L |
| #6304 | Migration deadlock with long queries | migration, perf | Add lock_timeout + advisory-lock pattern | M |
| #5713 | Inserts in migration are slower than outside | migration, perf | Profile our `migration/engine.ts`; likely identical issue | M |
| #5322 | Schema comparison slow for large schemas | migration, perf | Linearize ours against quadratic in `migration/diff.ts` | M |
| #1840 | Detect operations needing user input | migration | We have unsafe-gate; extend to "ambiguous" prompts | M |
| #5617 | User-specified IDs in migrations | migration | Add data-migration helper API | M |
| #1772 / #1461 | RFC1000 migration features | migration | Audit our diff generator vs. RFC | L |
| #5190 | Backport migration rewrites | migration | We don't have versioned rewrites yet | M |
| #2564 | Removing/reordering enum values | migration | We support add; need remove + reorder | M |
| #4583 | `START MIGRATION REWRITE` | migration | Schema rewrite mode for major refactors | M |
| #3452 | Schema generation from existing DB | migration, devtools | `disc introspect --output schema.esdl` — adoption lever | M |
| #702 | Schema import/export | migration, cli | Compose with #3452 | S |
| #3761 | "Compact" migrations / push command | migration, devtools | Already partially in `767afb7`; finish push | S |
| #7469 | Single-file schema export | migration, devtools | Trivial wrapper over schema/AST → SDL printer | S |
| #7563 | All public CLI flags via env vars | devtools, cli | Standard envvar mapping audit | S |
| #5911 | Run CLI programmatically | cli | Expose `cli/api.ts` with Deno-compatible programmatic surface | M |
| #3437 | Homebrew formula | devtools | Brew tap + formula | S |
| #3406 | Offline setup | devtools, cloud | Bundle PG binary download manifest in tarball | M |
| #4172 | SCRAM auth over HTTP-tunneled binary protocol | auth | Already have SCRAM; add HTTP tunnel mode | M |
| #4095 | Custom error message on access policy denial | auth | `access/parser.ts` already parses messages; wire through | S |
| #6432 | Access policy management features | auth, devtools | UI-side schema browser already shows them; add introspection API | M |
| #6358 | Toggle `apply_access_policies` for GraphQL/HTTP | auth | Per-request override header | S |
| #7525 | Authenticate `ext::auth` server endpoints | auth | Lock down `/auth/*` routes by default | S |
| #3872 | Configurable TLS cipher suites/curves | auth | Deno's TLS config supports it; expose | S |
| #7629 | Invisible link button in auth emails | auth | Update default email template CSS | S |
| #7972 | Auth email button background color | auth | Same template fix | S |
| #7938 | Constraints on auth app config | auth | Sanitize `appName`/`logo_url` etc. | S |
| #6731 / #6732 | Set app name without built-in UI | auth | Config surface | S |
| #6433 | Auto-allow configured `redirect_to` URLs | auth | Pair with #7468 work already done | S |
| #8028 | Custom Magic Link URL | auth | Already have magic links; add URL template config | S |
| #8026 | Custom OAuth callback URL | auth | Same | S |
| #7344 | Get authenticated user data from OAuth | auth | Profile fetcher in `ext-oauth/providers.ts` — partly done | S |
| #7196 | WebAuthn options without email | auth | Discoverable credentials / conditional UI | M |
| #7275 | Return identity on email+password registration | auth | API contract change — small | S |
| #6502 | (DONE) | | | |
| #6503 | Resend verification reuses old PKCE | auth | Issue new challenge per send | S |
| #7596 | PKCE trailing `=` failure | auth | Strip in `auth/pkce.ts` | S |
| #7026 | Alias PKCE "challenge" param for RFC | auth | Backwards-compat aliases | S |
| #7311 | Magic link UX: email not sent w/o signup | auth | Make registration implicit on magic link | S |
| #7360 | Email+password: non-existing account UX | auth | Equalize timing (already done at `01bd379`); also fix UI message | S |
| #7483 | Verify email cross-device | auth | Already works via token; document | S |
| #4209 | ISE on creating role w/ empty password | auth | Validate at API layer | S |
| #5383 | Can't set password via `--admin` | cli, auth | Wire `disc admin set-password` | S |
| #6454 | Password CLI option/env doesn't work | auth, cli | Same area | S |
| #7103 | Missing deletion policies in auth ext | auth, db | Cascade rules in our `auth/schema.ts` | S |
| #8909 | In-place upgrades & auth update | auth, migration | Tied to #6697 | M |
| #5504 | UNLESS CONFLICT misbehaves w/o select access | auth, db | Access-policy x conflict-resolution edge case | M |
| #8811 | Audit stdlib for permissions | auth, db | Run through our std::* implementations | M |
| #1147 | ISE during migration | migration | Generic — we'd handle by virtue of fresh impl, but verify | S |
| #4406 | Optional keyword on already-optional field | migration | Idempotent migration pass | S |
| #4343 | Cannot DROP CONSTRAINT | migration | Probably already works in our diff; add test | S |
| #4215 | Migrate type of computed global | migration | Likely needs a code path | M |
| #2071 | Migrations fail after dump/restore | migration | Round-trip test | S |
| #2204 | Migrations not propagated to existing connections | migration | Schema-version bump notify | M |
| #5641 | Complex schema → missing FROM-clause | migration, db | Smoke test & fix | M |
| #8517 | Cannot drop enum but only altering | migration | Enum migration edge case | S |
| #7724 | Extension upgrades | migration | We have an extension model already | M |
| #2292 | TLS for Postgres connections | db | Should already work via deno-pg; verify | S |
| #3534 | Listen on multiple TCP ports | infra | Disc supports one HTTP + one binary; multi may not be needed | M |
| #648 | SQLite back-end | db, storage | Stretch — Disc is Postgres-first by design; deferrable | L |
| #3510 | External UUIDs | db | Add `id` override at schema level | M |
| #5505 / #6517 | Access policies slow performance | auth, perf | Profile our `access/evaluator.ts` once usage scales | M |
| #1634 | Reduce cost of new connections | perf | Connection pooling already exists; warm-cache audit | M |
| #4319 | (above) | | | |
| #1325 / #2651 | "Named instance" DX confusion | cli, devtools | Naming review pass | S |
| #5158 | Project init timeout | cli | Already much better in our impl; smoke test | S |
| #5480 | ClientConnectionFailedError on certain networks | cli | DNS/IPv6 handling | S |
| #9117 | gel-py command on Windows 11 | cli | Cross-platform CLI — verify we handle Windows correctly | M |
| #9034 | CLI migration succeeds, server fails | cli, migration | Better preflight check | S |
| #8762 | Auto project init leaves bad state | cli | Already gets `disc.toml` cleanup right; verify | S |
| #8899 | `migration status` partial output | cli, migration | Format fix | S |
| #8273 | Document connection resolution algorithm | docs, cli | We have `lib/project-context.ts`; document | S |
| #8421 | Document `GEL_SERVER_PASSWORD_HASH` | docs, auth | We use bcrypt; document the env-var equivalent | S |
| #6648 | Document error codes & meanings | docs | (above) | S |
| #6119 / #5820 / #5819 | Document UI / UI button visibility | docs | UI documentation pass | S |
| #6127 | Test guide | docs | We have tests; write the guide | S |
| #6543 | New SDL loading strategy | migration, code-quality | Architecture-level cleanup | L |
| #4583 | (above) | | | |
| #4308 | Modify stdlib during minor upgrades | migration, db | Standard library versioning story | M |
| #2834 | Migration fails on object-handling functions | migration, db | Edge case | S |
| #4901 | Docker latest tag mismatch | cloud | Fix our release CI tagging | S |
| #5699 | Push images to GHCR | cloud, devtools | Already in GHCR? Verify | S |
| #4806 | PR preview environments | cloud | Uffizzi-style; nice-to-have | M |
| #5755 | CORS in cloud | cloud | Same issue as #6655 | S |
| #5030 | No-TLS for reverse-proxy mode | cloud, auth | `serve --no-tls` flag for behind-LB deployments | S |
| #6598 | Multi-tenant logging | cloud | Add tenant tag to log lines | M |
| #2230 | Update migration workflow docs | docs, migration | Cross-link with our docs | S |
| #7382 | Improved docs search | docs | Search infra; deferrable | M |
| #7411 | Language server features | devtools, cli | LSP for `.esdl` — adoption lever | L |
| #2401 | Doc complex mutations | docs | EdgeQL guide expansion | M |
| #3265 / #3366 / #2157 | Doc clean-ups | docs | Steady-state | S |
| #1276 | Add Rust bindings to roadmap | docs, sdk | We have TS-only; defer Rust | S |
| #4943 / #61 / #39 / #5097 | Roadmap & doc updates | docs | Steady-state | S |
| #3854 | Java client library | sdk | Out of scope for Disc v1; mention in roadmap | L |
| #3485 | NextAuth ORM adapter | sdk, auth | TS-native, fits well; community-grade | M |
| #3522 / #3560 / #4590 / #2080 | Better error reporting | devtools | Pass through `parseWithRecovery` work | S |
| #4334 | Brew update messaging | cli | Once #3437 (brew formula) lands | S |
| #2204 | (above) | | | |
| #1147 / #4789 / #4766 / #3280 / #5060 / #5132 / #5497 / #4343 / #4406 / #4215 / #5641 | Various migration robustness bugs | migration | Smoke-test our impl against the same input fixtures; most likely fine, but verify | M (collectively) |
| #5132 | Cannot drop alias depending on its own computed link | migration | Edge case | S |
| #1489 | Compile produced DDL before dumping | migration | Already in our pipeline; verify | S |
| #4351 | `RESET SCHEMA TO initial` | migration | Stretch | M |
| #4600 | Drop DB and re-create | cli, migration | We have `disc db wipe` — covers it | S |
| #2910 | Migration errors in CI | migration, devtools | Better non-TTY error output | S |
| #2910 / #1840 / #1865 / #1772 | Various migration features | migration | Track via meta-issue | — |
| #3208 | Migration creation fails despite no questions | migration | Likely edge case; add fixture | S |
| #2647 / #4334 / #1218 / #1030 | CLI ergonomics | cli | Already partially done; close out | S |
| #725 | Code quality automation | devtools | Already have lint+fmt+test; add coverage | S |
| #655 | VSCode language server | devtools | Tied to #7411 | L |
| #357 / #5097 / #61 / #39 | Where's the dockerfile / docs roadmap | docs | We have one; keep it current | S |
| #1613 | Getting started doc | docs | We have `docs/getting-started.md`; verify | S |
| #184 / #61 | Non-technical example schema | docs | Switch examples to a relatable domain | S |
| #12 | Tool for testing doc examples | devtools, docs | doctest-style runner | M |
| #4408 | (above) | | | |
| #838 | Build instructions not full | docs | `deno task` audit | S |
| #673 | Add favicon | UI | Trivial | S |
| #3437 / #4334 | Homebrew | devtools | (above) | S |

(Pickable now: ~80 items; many small, several large. Sort within Disc roadmap separately.)

### SKIP — not applicable to Disc

| # | Title | Reason |
|---|-------|--------|
| #8716 | OAuth `IdentityCreated` not fired in Gel | Gel auth-extension bug; our webhook impl already fires it (`47e6f38`) |
| #8640 | OIDC provider docs | Disc has its own docs; cherry-pick examples not the doc commit |
| #8422 | Gel Python `WebAuthnFactor` keyword bug | Python-impl-specific; our TS impl unaffected |
| #8909 | Gel auth in-place upgrade bug | Tied to Gel's Python migration tooling; our migration tracker is fresh |
| #8273 | Connection resolution algorithm docs | Documented in our `lib/project-context.ts`; minor SKIP |
| #8421 | `GEL_SERVER_PASSWORD_HASH` docs | Gel-specific env var; document `DISC_*` instead — covered above |
| #8186 (DONE) | OTC | — |
| #8517 / #8500 | Gel SDL migration loader bugs | Our parser is independent; spot-check, then SKIP if green |
| #8909 / #8790 | Gel cloud-specific upgrades | Cloud-only |
| #6948 | Cloud key-specific rights | Cloud-only |
| #8539 | Gel cloud auth | Cloud-only |
| #5842 / #5755 / #4901 / #5699 / #5518 | Gel Docker/cloud bugs | Mostly Disc-fresh, minor verification |
| #6598 | Multi-tenant logging | Stretch — pickable not skip; moved to BUILD |
| #5005 | Roadmap webpage | We have our own |
| #5158 / #4022 / #3969 / #2828 / #3479 / #2187 / #2940 / #2847 | Gel-Python project-init bugs | Our `cli/init.ts` is fresh — spot test, then SKIP |
| #6126 / #6096 / #6094 / #6083 / #6119 / #6127 / #6648 / #6122 / #6112 / #6120 / #4787 / #4943 / #4787 / #2401 / #5023 / #2230 / #5644 / #4239 / #4170 / #1163 / #1613 / #1276 / #6547 / #5097 / #4943 / #5820 / #5819 / #5097 / #61 / #357 / #184 / #39 / #4177 / #6622 / #4943 / #2206 / #2157 / #3565 | "Documentation of X" | Disc maintains its own docs at `/docs/`; cherry-pick examples as inspiration but SKIP the underlying issues |
| #7297 | `configure branch` logs wrong message | Gel-only branching model — Disc uses different model |
| #7193 | Patch-old-version pre-release tests | Gel internal CI |
| #7150 | 5.0-beta-to-beta upgrade restore protocol | Gel internal |
| #7095 / #7056 / #6916 / #5497 / #5492 / #5483 / #5408 / #5114 / #2306 / #2307 / #2314 / #2296 / #2089 / #2085 / #1987 / #1895 / #1865 / #1841 / #1681 / #1736 | Gel-specific migration internal bugs | Spot-test, mostly SKIP |
| #6831 | Single-user mode password | Gel-specific deployment mode; our model differs |
| #6673 | GraphiQL auth method | We don't ship Gel's GraphiQL-as-tunnel; our admin UI handles it |
| #6543 | New SDL loading strategy | Architectural for Gel; we already loaded SDL differently — SKIP |
| #5641 / #5132 / #5060 / #4789 / #4766 / #4406 / #4343 / #4215 / #4192 / #4191 / #4186 / #5132 / #5497 / #5408 / #2834 / #3522 / #3521 | Gel migration internal failures | Most are Gel-Python migration codegen bugs; verify our equivalent passes |
| #6464 | (not in our list) | — |
| #4408 | Pre-commit/CI | Pickable; moved to BUILD |
| #4806 | PR preview envs | Disc has its own CI; defer |
| #4334 | brew update messaging | BUILD |
| #4253 | Musl Linux | We bundle Postgres binaries; verify musl path |
| #1129 | Superuser CLI | BUILD |
| #1218 | `\d` REPL fix | BUILD |
| #5234 | Instance-level config via CLI | BUILD |
| #5386 | `EDGEDB_SERVER_ADMIN_UI` env var | Gel-specific; we have our own knob |
| #2643 | `EDGEDB_SERVER_*` prefix uniformity | Gel-specific; we use `DISC_*` — already uniform |
| #5302 | Prometheus in remote-compiler mode | Gel architecture-specific |
| #1454 | Split build/test CI jobs | Gel internal CI |
| #1832 | Could not compile `edgeql-rust` | Gel Rust crate |
| #1819 | Event sourcing projections | Architectural fork — track separately |
| #1794 | Mark optional types in AST | Gel codebase |
| #1752 | Rename string functions | Gel API stability decision |
| #5805 | Tests for the patch system | Gel-internal |
| #5781 | dev/prod workflow guide | docs — pickable as BUILD |
| #5759 | (not in 8-10 band) | — |
| #5363 | GraphQL back-endless mode docs | We don't have this mode |
| #5159 | (n/a) | — |
| #4313 | Disable GraphQL introspection in prod | We don't ship GraphQL introspection by default |
| #4322 | N+1 in GraphQL | Compiler-level — only matters if we ship GraphQL ext |
| #4151 / #4136 / #4219 / #6133 | Access policy semantics edge cases | We rebuilt this; verify, then mostly SKIP |
| #4079 | Link project to multiple dirs | Gel-Python project model |
| #4052 / #3638 / #3454 / #3477 / #3428 / #4409 | Cloud-platform deploy bugs | Verify each platform; mostly external |
| #3896 | Socket activation | Stretch infra |
| #3871 | Disable TLS renegotiation | Already off in modern Deno TLS — verify |
| #3774 | Expose `gen_random_uuid()` | Done at `a067c97` |
| #3733 | Skip prompts for first migration | Pickable as BUILD; small |
| #3609 | TS query-builder + pnpm | Verify our codegen plays with pnpm |
| #3562 | UnknownIssuer cert | Document trust-store steps |
| #3502 | Composite exclusive constraint KeyError | Gel-specific; verify |
| #3446 | Blog RSS feed | We don't have a blog yet |
| #3414 | Confusing constraint-change prompts | Pickable as BUILD; small |
| #3208 | Migration creation fails | BUILD |
| #3170 | Misleading disconnect log in CLI | Pickable |
| #3131 | Generate Prometheus docs | docs |
| #3019 | Query playground | We have admin UI query editor |
| #2948 | Test mode connecting to existing instance | Pickable |
| #2882 | ANTLR4 grammar | We use a hand-rolled parser; SKIP |
| #2848 | NoneType auth method ISE | Python; SKIP |
| #2673 | Anchor/sticky doc links | docs |
| #2651 | Named instance DX | BUILD |
| #4715 / #4697 / #4659 / #4635 / #4586 / #4408 / #4253 / #4289 / #4022 / #3969 / #2828 / #2187 / #1218 / #5602 / #5532 / #5187 / #5162 / #4801 / #5158 / #5480 | CLI / install bugs | We have a fresh CLI; verify-then-SKIP for most |
| #5043 | Coordinated release publishing | We do this already |
| #2549 / #2547 / #2409 / #2380 / #2328 / #2314 / #2307 / #2306 / #2296 / #2089 / #2085 / #1987 / #1895 / #1865 | Gel migration bugs | Verify-then-SKIP |
| #2243 / #2230 / #2206 / #2157 / #2078 / #2071 / #2204 | Migration features (some DONE, some BUILD, some SKIP) | Per-issue judgment above |
| #1672 | (n/a) | — |
| #1490 / #1489 / #1486 / #1485 / #1461 / #1325 / #1276 / #1218 / #1163 / #1147 / #1119 / #1030 / #1023 / #1021 / #967 / #930 / #893 / #859 / #846 / #838 / #757 / #725 / #720 / #673 / #655 / #648 / #631 / #594 / #497 / #465 / #357 / #237 / #187 / #184 / #152 / #146 / #135 / #120 / #80 / #61 / #41 / #39 / #37 / #12 | Older items | Most map to BUILD (small) or already DONE; SKIP otherwise |

(SKIP rationale per category, summary: ~120 items where the issue is either Gel-Python-specific, Gel-Rust-specific, EdgeDB-Cloud-specific, documentation-of-Gel, or Gel-internal-tooling. Disc gets the benefit of a fresh implementation and doesn't inherit the bug.)

### DROP — upstream Gel rejected (closed `not_planned`)

| # | Title | Why dropped |
|---|-------|-------------|
| #7482 | Disable new sign-ups per provider | Gel rejected; we kept aligned, then reversed at `1aa19c5` (documented `allowRegistration` use case) — effectively partially BUILD |
| #7341 | CAPTCHA in auth UI | Gel rejected; we shipped opt-in CAPTCHA at `314634b` despite that — Disc's stance here diverges |

(Only 2 confirmed DROPs in the high-relevance band; we re-shipped both because Disc's threat model differs.)

## Medium Relevance (score 5-7) — 789 issues, category-level rules

Sample: 40 items inspected across categories at lines 263-460, 700-900, 1000-1057.

### Rules by category

- **auth** (medium, ~80 items): mostly SCRAM/OAuth/PKCE edge cases. Most are Gel-Python implementation bugs that don't apply to Disc's TS auth. **Default: SKIP**, but cherry-pick anything that turns out to be a protocol-level concern (e.g. #3639 SCRAM concurrency, #5862 `current_role` query function). **Pickable in BUILD: ~10 items.**

- **migrations** (medium, ~250 items): the biggest medium category. Most items are Gel-internal migration-tooling bugs (DDL generation off-by-one, type-system edge cases, ISEs in `gel migration create`). **Default: SKIP** because Disc's migration engine was rebuilt and doesn't inherit them. Use the bug list as a fixture set: when our diff engine fails on schema X, check if Gel had a corresponding ticket. **Pickable: ~5-10 features (auto-rename indexes #8016, RESET SCHEMA #4351, etc.).**

- **database-core** (medium, ~150 items): EdgeDB-internal compiler/query-engine bugs. **Default: SKIP**. Disc's compiler is fresh; we don't inherit Gel's compiler bugs. Pick only items describing a *feature* (e.g. #6480 two-phase commit, #6527 schema-level exclusive constraints).

- **query-language** (medium, ~80 items): EdgeQL semantics — most are bugs in Gel's compiler, a few are language-spec gaps. **Default: SKIP** for bugs; **BUILD** for a few language features we want (e.g. #6940 JSON-schema-based query generator, #4596 cursor pagination).

- **performance** (medium, ~50 items): Gel-specific perf bugs (PG plan cache, materialization). Run `disc bench` against same workloads; if our numbers are fine, **SKIP**. Otherwise pick.

- **devtools** (medium, ~80 items): mixed — CI tooling, watch mode, IDE integration. **BUILD**: language-server-related (composes with #7411 from high). **SKIP**: Gel-internal CI/build tooling.

- **documentation** (medium, ~110 items): **SKIP** all. Disc has `/docs/`; we don't import Gel's docs structure or content. Use as inspiration when writing Disc docs but don't track per-item.

- **cli-tooling** (medium, ~70 items): mostly Gel CLI bugs on specific platforms (Windows, WSL, M1). **Default: SKIP** because our CLI is fresh; cross-platform CI catches regressions.

- **cloud-hosting** (medium, ~60 items): EdgeDB Cloud-specific. **Default: SKIP** — Disc has no managed cloud product. Pick anything that's actually self-hosting-relevant (Helm tweaks, k8s operator hints).

- **sdk-client** (medium, ~30 items): Gel client library bugs (TS, Python, Rust, Go). **Default: SKIP** for non-TS clients; **BUILD** when our TS SDK has the same gap.

- **storage** (medium, ~5 items): mostly storage-engine internals. **SKIP**.

- **compiler / code-quality / sql / unrelated**: too few items to rule on; one-by-one.

### Specific medium items worth flagging

| # | Title | Why |
|---|-------|-----|
| #5862 | Function to get current authenticated role | We shipped RBAC; this is the natural API completion |
| #4596 | Cursor-based pagination | UI viewer + GraphQL ext both want it |
| #4941 | Initial FTS take (RFC 1015) | Future feature; track for v2 |
| #4322 | Compiler-level GraphQL N+1 | Only relevant once GraphQL ext is hot |
| #6940 | JSON-schema query generator | Adoption lever for cross-language clients |
| #1610 | Partial constraints/indexes | Real DB feature; pick when needed |
| #5066 | Multi-sequence support | Stretch |
| #3916 | CDC / logical replication | Big — but huge adoption lever |
| #3774 | Expose `gen_random_uuid` | Done at `a067c97` (covered by std::* crypto) |
| #6884 | DB config in migrations | Real feature gap — connect to migration engine |
| #8625 / #8624 | Reranking / hybrid search | Vector ext territory; future |
| #3534 | Listen on multiple ports | Niche; only when self-host requests it |
| #5921 | (no — not in list) | — |
| #4151 / #4136 / #4219 | Access policy edge cases | Audit our `access/evaluator.ts` against these |
| #5862 | (above) | |
| #6480 | Two-phase commit | Future distributed-tx story |
| #6527 | Schema-level exclusive | We handle exclusive constraints; verify schema-level form |
| #8016 | Auto-rename indexes in migrations | DX win; probably small |
| #3759 | Custom shorter IDs | Not for v1; stretch |

## Low Relevance (score 0-4) — 1,676 issues, bulk rule

**Default: SKIP all.** This bucket is dominated by Gel-internal compiler bugs, EdgeQL syntax decisions, EdgeDB-Cloud-specific deployment errors, EdgeDB Python codebase issues, very narrow query-language edge cases (e.g., `?? operator on link property top level`, `enumerate ignores clauses on implicit SELECTs`), and pre-1.0 keyword renames. None of it transfers to a fresh TypeScript/Deno reimplementation with a redesigned compiler. Revisit only if a specific issue # is referenced by an upstream cherry-pick or a user bug report. Do not enumerate. The whole bucket can be treated as "search by keyword if and only if a downstream consumer hits the symptom."

## Recommended next picks

Top 5 from BUILD column, ranked by leverage = (correctness > UX > infra) × (effort: S > M > L) × (unblocks-downstream-features):

1. **#5988 + #6444 — Mark config variables as `secret` (S)**
   Pair of issues. Add `secret: true` to config schema; introspection respects it; UI masks it. Unblocks safer admin UI exposure of OAuth secrets, JWT keys, SMTP creds. ~half-day each, both at the same surface (`lib/config.ts` + `ui/src/routes/config`).

2. **#6655 + #5755 + #5030 — Configurable CORS + no-TLS reverse-proxy mode (S)**
   Three issues, one PR. Removes friction for everyone running Disc behind nginx/Traefik. Currently a self-host blocker for non-localhost UI use.

3. **#3452 + #702 + #7469 — Schema export/import + introspect existing DB (M)**
   Adoption lever for users porting from Gel/Postgres. Gives `disc introspect` and `disc schema export`. Gel users can't migrate to Disc easily today; this fixes that.

4. **#1129 + #5383 + #6454 + #1119 + #4209 — Superuser CLI + admin password ops (M)**
   Wires the RBAC role registry shipped at `df92455` into the CLI. Currently roles are API-only. `disc admin create-superuser` + `disc admin set-password` close the loop. Also fixes #4209 ISE on empty-password.

5. **#7411 + #655 — Language Server (L)**
   Stretch but high-leverage. LSP for `.esdl` schema files (and EdgeQL queries). Composes with VS Code extension #655. Multi-month, but unlocks a chunk of remaining DX issues from FUTURE.md medium band in one stroke.

Honorable mentions for "do today" S-bucket: #6648 (document error codes), #4787 (audit config docs), #1218 (`\d` REPL fix), #3437 (Homebrew formula).
