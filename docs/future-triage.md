# FUTURE.md Triage

> Status of every Gel issue tracked in `FUTURE.md` against Disc's roadmap.
> Generated: 2026-05-05 · Last updated: 2026-05-07 (Bundles I–KK closed Disc-original-features roadmap + 22 more upstream items + LSP Phases 5–7 + Homebrew + auth router hardening + PG TLS support + zero `deno check` errors project-wide)
>
> **The DONE table below is a snapshot as of Bundle H (2026-05-06 morning); the BUILD table was de-duped 2026-05-07 after Bundles I–KK shipped.** Subsequent same-day sweeps (Bundles I through KK — see the post-Bundle-H sweep table) shipped Disc's eight original features, the LSP, additional auth/migration polish, 12 structural-divergence pins, and a full project-wide `deno check` cleanup. See `CHANGELOG.md` `[Unreleased]` for authoritative bundle details. The Summary tally below tracks the running total.

## Methodology

For each candidate, cross-check against (a) Disc codebase state and (b) upstream Gel issue state. The intersection gives the action:

| Disc →                     | DONE               | PARTIAL                      | NOT-DONE                                                       |
| -------------------------- | ------------------ | ---------------------------- | -------------------------------------------------------------- |
| **Gel open**               | SKIP (we're ahead) | BUILD (fix the gap)          | BUILD (lead upstream)                                          |
| **Gel closed-completed**   | SKIP               | BUILD (port the merged PR)   | BUILD (port the merged PR)                                     |
| **Gel closed-not_planned** | SKIP               | DROP (or justify divergence) | DROP (Gel rejected for a reason — re-evaluate before reviving) |

Two issues fall into a fifth bucket: Disc deliberately diverges from Gel's `not_planned` decision because the threat/UX model is different (#7341 CAPTCHA, #7482 disable-signup-per-provider).

## Summary

- **DONE**: 118 high-relevance items shipped in disc (108 in the DONE table snapshot + 10 ports from the post-Bundle-H sweep — Q/U/FF/GG/HH/II). Cross-referenced with `git log`.
- **PIN**: 22 high-relevance items recorded as Disc-vs-Gel divergence with regression pins (no behavior change; structural reality of the Disc rewrite makes the Gel-side bug class inapplicable). Live in `tests/gel-divergence-pins.test.ts` and `migration/gel-issues.test.ts`. Includes #4408, #4172, #3208, #5132, #2910, #3872, #7360, #3170, #5158, #5480, #8762, #7972 + the in-DONE-table pins (#4334, #3733, #3414, #4343, #1147, #5617, #2071).
- **BUILD**: 33 high-relevance items still pickable (the snapshot listed ~80 with overlap; Bundles I–KK closed 22 + pinned 12 — see the de-duped table below).
- **SKIP**: ~120 high-relevance items not applicable to Disc (Gel-internal, Gel-Python, Gel-cloud-specific, or Disc-already-handled by virtue of being a fresh TS rewrite).
- **DROP**: 2 high-relevance items upstream rejected (#7482, #7341 — already documented in prior audit; #7341 was actually re-implemented in Disc as opt-in CAPTCHA).
- **Medium (789) and Low (1,676)**: handled via category-level rules below; no per-issue enumeration.

**Running tally (high-relevance band): 142 Gel issues tackled** (118 ports + 22 pins + 2 drops). Plus **8 Disc-original features** (Bundles I, J, K, L, M, N, O, P) net new — single-binary distribution, schema-derived REST surface, live schema diff + data subscriptions in admin UI, codegen-free TS query builder, visual query builder, identity-disc visualization, Deno-permission-aware access policies. Authoritative: `CHANGELOG.md` `[Unreleased]` for post-Bundle-H specifics.

### 2026-05-06 BUILD-bundle sweep

Seven sequential bundles, 41 issues closed, 21 commits, all on `origin/primary`. Cross-check methodology validated: ~7 issues were already-correct in Disc (regression pins added), 1 was a real parser bug (#4406), 1 was scoped down (#4583 — Gel feature has no Disc equivalent), Bundle G was a pure docs sweep, the rest were genuine ports/feature additions.

| Bundle                     | Issues closed                                                               | Commits                                               |
| -------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1 — recommended next picks | #4095, #1218, #1030, #1325                                                  | `087c57b`, `9f2adc8`, `43f2410`, `3f20adc`            |
| B — auth polish            | #6503, #7275, #7596, #7026, #6433                                           | `6dcbc95`, `d9008e6`, `2253c39`                       |
| C — migration sweep        | #4406, #1147, #4343, #2071, #8517 (initial pin)                             | `08e5533`, `0c71d97`                                  |
| D — observability + errors | #6205, #5405, #930, #6648                                                   | `0038920`, `ae677c7`, `735e377`                       |
| E — auth-config surface    | #7344, #8026, #7938, #6731, #6732, #8028 + brandColor OKLCH                 | `268c296`, `7614ac7`, `2a2353e`                       |
| F — migration cluster      | #8517 (full impl), #2564, #1840, #5617, #4583 (scoped down), #6304          | `1490ac5`                                             |
| G — docs sweep             | #6126, #6096, #4170, #6176, #4239, #1163, #1021, #4787, #2230, #8273, #8421 | `041035f`, `fdaccbf`, `5d3a0b1`, `c4abb9a`, `32f5e96` |
| H — env-var gaps + docs    | #5234, #7563, #4547, #4943, #6094, #4334, #3733, #3414                      | `fe1738b`, `7dcd1a9`, `4080cb0`                       |

### 2026-05-06–07 post-Bundle-H sweep

A second same-day sweep shipped 18 more bundles (I–CC), closing Disc's eight original features and a handful of additional upstream items. The DONE/BUILD enumeration below predates these — `CHANGELOG.md` `[Unreleased]` is authoritative for anything shipped after Bundle H.

| Bundle | Subject                                                                                                                      | Source                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| I      | Single-binary distribution (Disc-original feature #4)                                                                        | `fcebdb1`                                  |
| J      | Schema-derived REST surface (Disc-original feature #2)                                                                       | `7b1d3cf`, `3a3d7d1`                       |
| K      | Live schema diff in admin UI (Disc-original feature #3a)                                                                     | `cfe9533`, `8be5d73`                       |
| L      | Live data subscriptions in admin UI (Disc-original feature #3c)                                                              | `3021c3c`, `5730b3d`, `ceaebb0`, `cfdcdd2` |
| M      | Codegen-free TS query builder (Disc-original feature #1)                                                                     | `c7ace89`, `caa7bb4`                       |
| N      | Visual query builder (Disc-original feature #3b)                                                                             | `d204b66`                                  |
| O      | Identity-disc visualization (Disc-original feature #3d)                                                                      | `b7db3c9`                                  |
| P      | Deno-permission-aware access policies (Disc-original feature #5)                                                             | `a445cb5`                                  |
| Q      | Auth polish: #7311 implicit signup, #7196 WebAuthn discoverable creds, #7483 docs                                            | `cd735bb`                                  |
| R      | `--require-auth` / `--read-only` / `--trust-proxy` CLI flags (#5234)                                                         | `bd3822a`                                  |
| S      | Migration robustness pins (#3208, #5132, #2910)                                                                              | `33c7c03`                                  |
| T      | LSP Phase 5: embedded EdgeQL diagnostics in TS/JS                                                                            | `18ddd02`                                  |
| U      | Bulletproof CTA buttons in auth emails (#7629)                                                                               | `a0c1744`                                  |
| V      | LSP Phase 6: hover + completion inside `eql\`...\``                                                                          | `4537390`                                  |
| W      | Scalar/enum migration end-to-end (#8517 full impl + cascade ordering)                                                        | `c39aa26`                                  |
| X      | Structural-divergence pins (#4408 pre-commit, #4172 SCRAM-tunneled)                                                          | `2dd49c7`                                  |
| Y      | Phase 23 polymorphic test fixtures rewritten to per-subtype tables                                                           | `ded914e`                                  |
| Z      | CI builds UI before non-PG test suite                                                                                        | `c2e99f5`                                  |
| AA     | LSP Phase 7: cross-file SDL resolution                                                                                       | `35071fd`                                  |
| BB     | Polymorphic shape fields project subtype-specific cols in UNION                                                              | `eedd27d`                                  |
| CC     | Cross-platform reproducible builds via per-platform PG staging                                                               | `85bf883`                                  |
| DD     | Documentation audit — high-severity gaps                                                                                     | `840c3c0`                                  |
| EE     | Documentation audit — medium + low gaps                                                                                      | `09925ea`                                  |
| FF     | Homebrew Formula (#3437)                                                                                                     | `34902d6`                                  |
| GG     | Auth router lockdown (#7525) + admin policy bypass (#6358) + TLS cipher pin (#3872)                                          | `9971268`                                  |
| HH     | Migration drift status (#8899) + running-server preflight (#9034) + login/CLI pins (#7360, #3170)                            | `ba08a24`                                  |
| II     | PG `?sslmode=` parsing (#2292) + verification pins (#5158, #5480, #8762, #7972)                                              | `fea2ce8`                                  |
| JJ     | Pre-existing TS errors cleared (logger.warn signature, Uint8Array, LinkDef.computed, RegisterData.username)                  | `f55e200`                                  |
| KK     | `deno check` clean across whole project (151 errors → 0; LoginResult helpers, Result narrowing, legacy SCRAM shims)          | `55cc01c`                                  |
| LL     | Migration-perf cluster: differ linearization (#5322) + structural pins for #5713 (insert speed), #4319 (in-process)          | `80816fb`                                  |
| MM     | Auth-semantics cluster: webauthn_challenges cascade (#7103) + structural pins for #5504 (UNLESS CONFLICT), #8811 (stdlib)    | `edd2f6b`                                  |
| NN     | CLI/devtools cluster: programmatic CLI surface (#5911) + offline-setup env vars (#3406) + named-instance DX pin (#2651)      | `78002f7`                                  |
| OO     | DB/engine correctness cluster: pins for #5641 (multi-module FROM), #4215 (extending-change gap), #2204 (schema-reload chain) | `3a4fdaa`                                  |
| PP     | #4215 follow-up: differ now detects type-level `extending` changes via resolved inheritance walk; pin upgraded to behavioral | (this bundle)                              |

Issues from the BUILD column closed in this post-snapshot sweep: **22 net new** — #7311, #7196, #7483 (Q), #7629 (U), #3437 (FF), #7525, #6358, #8899, #9034, #2292 (GG/HH/II), and structural-divergence pins for #4408, #4172 (X), #3208, #5132, #2910 (S), #3872, #7360, #3170 (GG/HH), #5158, #5480, #8762, #7972 (II). The Disc-original-features roadmap is also fully closed by this sweep — see `docs/disc-original-features.md`.

## High Relevance (score 8-10) — full enumeration

### DONE — already shipped in Disc

| #     | Title                                                | Shipped in                                                                                       |
| ----- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| #496  | Password authentication + basic auth infra           | `auth/provider.ts`                                                                               |
| #528  | JWT for HTTP ports                                   | `auth/middleware.ts`                                                                             |
| #1486 | `edgedb wipe` / `restore --force`                    | `767afb7`                                                                                        |
| #1485 | Restore does not restore databases                   | `767afb7`                                                                                        |
| #1838 | Safe/unsafe migration classification                 | `migration/engine.ts`                                                                            |
| #1002 | Dump/restore from stdin/stdout                       | `767afb7`                                                                                        |
| #720  | Backup options                                       | `767afb7`                                                                                        |
| #2078 | Migration timestamps                                 | `migration/tracker.ts` (created_at column)                                                       |
| #3567 | File storage & upload                                | `lib/file-storage/`, `7e1961f`                                                                   |
| #4277 | TLS certificate hot-reload                           | `server/tls-reload.ts`                                                                           |
| #4278 | SIGHUP config reload                                 | `ae7e124`                                                                                        |
| #4300 | Migration rollback / reset                           | `cli/main.ts` rollback flags                                                                     |
| #4854 | Liveness/readiness endpoints                         | `server/http.ts` `/health/*`                                                                     |
| #5053 | Helm Charts                                          | `f9f438b`                                                                                        |
| #5065 | Cryptography & hashing functions                     | `a067c97` (std::* crypto stdlib)                                                                 |
| #5524 | Server-wide read-only mode                           | `ServerConfig.readOnly` + AST classifier                                                         |
| #6345 | Auth for GraphQL/HTTP                                | `server/http.ts` gateAuth + `config.requireAuth`                                                 |
| #6502 | Password reset bypassing email verification          | `9bdcf6f`                                                                                        |
| #6725 | WebAuthn / passkey                                   | `auth/webauthn.ts`, `6416c5f`                                                                    |
| #6726 | LinkedIn OAuth                                       | `5548f79`                                                                                        |
| #6727 | Facebook OAuth                                       | `5548f79`                                                                                        |
| #6728 | X/Twitter OAuth                                      | `5548f79`                                                                                        |
| #6908 | Zitadel / generic OIDC                               | `ext-oauth/discovery.ts`                                                                         |
| #7006 | Validate auth config / fail closed                   | `5b21b8d`                                                                                        |
| #7341 | CAPTCHA in auth UI                                   | `314634b` (re-introduced opt-in despite Gel "not_planned")                                       |
| #7367 | Magic Code Support                                   | `314634b`                                                                                        |
| #7370 | Keycloak OAuth Provider                              | `5548f79`                                                                                        |
| #7415 | Generic OpenID Connect provider                      | `ext-oauth/providers.ts`                                                                         |
| #7468 | Wildcard subdomains in redirect URLs                 | `92168fd`                                                                                        |
| #7484 | Auth lifecycle webhooks                              | `auth/webhooks.ts`, `47e6f38`                                                                    |
| #7490 | Migration progress visibility                        | `b7bedeb` + `767afb7`                                                                            |
| #7557 | OIDC profile information                             | `88ee80c`                                                                                        |
| #7752 | OAuth `extraAuthorizeParams`                         | `eb93633`                                                                                        |
| #8186 | OTC suite (TOTP + magic link + recovery)             | `4bc3929`, `7a1f92b`, `4b30aca`                                                                  |
| #8224 | Email auth requires SMTP                             | `314634b`                                                                                        |
| #8533 | SMTP cert validation toggle                          | `314634b`                                                                                        |
| #8750 | Anonymous / guest identity                           | `auth/provider.ts` `loginAnonymous`, `4fe83db`                                                   |
| #8773 | Migration `order` / `applied_order`                  | `179ac31`                                                                                        |
| #8841 | Auth flow state preservation                         | `88ee80c`                                                                                        |
| #8950 | Auth login error / PKCE cookie path                  | `88ee80c`                                                                                        |
| #9137 | Timing side-channel in secret comparison             | `protocol/scram.ts:172-181`                                                                      |
| #3465 | Single-command create+apply migration                | `8065541`                                                                                        |
| #6085 | Migration merge conflicts guidance                   | `dcab128` (docs)                                                                                 |
| #718  | GraphQL rate limiting                                | `8065541` (docs)                                                                                 |
| #6094 | Programmatic migration tooling guide                 | `migration/` exports + docs                                                                      |
| #5988 | Mark config variables as `secret`                    | `2643898` (`@secret` annotation + first-class field)                                             |
| #6444 | Expose `secret` flag in introspection                | `913e422` (`cfg::describe_settings()`)                                                           |
| #6655 | Configurable CORS `Access-Control-Allow-Origin`      | `e4f1e09` (CORS knobs + wildcard origin)                                                         |
| #5755 | CORS in cloud                                        | `e4f1e09` (same wildcard CORS work)                                                              |
| #5030 | No-TLS for reverse-proxy mode                        | `63ccbd8` (`trustProxy` gate)                                                                    |
| #702  | Schema import/export                                 | `9c150ec` + `46cdc44` (SDL serializer + `disc schema export`)                                    |
| #7469 | Single-file schema export                            | `46cdc44`                                                                                        |
| #3452 | Schema generation from existing DB                   | `0764bf6` + `57f0c75` (`disc schema introspect`)                                                 |
| #1129 | Explicit superuser CLI command                       | `8427899` (`disc admin create-superuser`)                                                        |
| #5383 | Can't set password via `--admin`                     | `8427899`                                                                                        |
| #6454 | Password CLI option/env doesn't work                 | `8427899`                                                                                        |
| #1119 | Better error on `create role`                        | `8427899`                                                                                        |
| #4209 | ISE on creating role w/ empty password               | `8427899`                                                                                        |
| #7411 | Language server features                             | `d5a0a85`/`3d74f85`/`fd16e28`/`b4c2ffc` (LSP through Phase 4)                                    |
| #655  | VSCode language server                               | same as #7411                                                                                    |
| #4095 | Custom error message on access policy denial         | `087c57b` (`errmessage` clause)                                                                  |
| #1218 | Fix `\d` REPL meta-command                           | `9f2adc8` (full describer for types/properties/links/policies)                                   |
| #1030 | `-H` for hostname / `-h` for help                    | `43f2410`                                                                                        |
| #1325 | Read configuration from local file                   | `3f20adc` (11 new `[server]` keys)                                                               |
| #6503 | Resend verification reuses old PKCE                  | `6dcbc95` (new `resendVerification` method)                                                      |
| #7275 | Return identity on email+password registration       | `6dcbc95`                                                                                        |
| #7596 | PKCE trailing `=` failure                            | `d9008e6` (`normalizePkceParam`)                                                                 |
| #7026 | Alias PKCE "challenge" param for RFC                 | `d9008e6` (already RFC-compliant; pin + shim)                                                    |
| #6433 | Auto-allow configured `redirect_to` URLs             | `2253c39` (already correct in `extension.ts:191-199`; pin tests)                                 |
| #4406 | Optional keyword on already-optional field           | `08e5533` (parser accepts `optional`/`single`)                                                   |
| #1147 | ISE during migration                                 | `0c71d97` (already-handled; regression pin)                                                      |
| #4343 | Cannot DROP CONSTRAINT                               | `0c71d97` (property-level works; type-level is divergence with Gel `not_planned`)                |
| #2071 | Migrations fail after dump/restore                   | `0c71d97` (PG-backed round-trip pin)                                                             |
| #8517 | Cannot drop enum but only altering                   | `1490ac5` (full scalar/enum diffing — `CreateScalar`/`AddEnumValue`/`RecreateScalar`)            |
| #2564 | Removing/reordering enum values                      | `1490ac5` (`RecreateScalar` op + cascade-aware DDL guard)                                        |
| #1840 | Detect operations needing user input                 | `1490ac5` (`MigrationOperation.classification` + ambiguous gate)                                 |
| #5617 | User-specified IDs in migrations                     | `1490ac5` (already worked via `id := <uuid>'…'`; pin)                                            |
| #6304 | Migration deadlock with long queries                 | `1490ac5` (`SET LOCAL lock_timeout` + `pg_advisory_xact_lock`)                                   |
| #4583 | `START MIGRATION REWRITE`                            | scoped down — Gel DDL/EdgeQL feature without Disc equivalent (SDL-only refactor flow)            |
| #6205 | Prometheus metric for TLS cert expiry                | `0038920` (two gauges, ASN.1 walker, refreshes on TLS reload)                                    |
| #5405 | Prometheus gauge metrics report timestamps as values | `0038920` (Disc never adopted `_created` convention; danger-band pin)                            |
| #930  | "Please file an issue" hint on ISE                   | `ae677c7` (idempotent `appendInternalErrorHint`)                                                 |
| #6648 | Document error codes & meanings                      | `735e377` (`docs/error-codes.md`)                                                                |
| #7344 | Get authenticated user data from OAuth               | `268c296` (extended `OAuthUserInfo` with emailVerified/givenName/familyName/locale)              |
| #8026 | Custom OAuth callback URL                            | `268c296` (already done via `redirectUri` + `?redirect_uri=` allowlist)                          |
| #7938 | Constraints on auth app config                       | `7614ac7` (strict validators in `auth/branding.ts`)                                              |
| #6731 | Set app name without built-in UI                     | `7614ac7` (first-class `AuthBrandingConfig` flows through templates)                             |
| #6732 | (same as #6731)                                      | `7614ac7`                                                                                        |
| #8028 | Custom Magic Link URL                                | `7614ac7` (`magicLinkUrlTemplate` config field)                                                  |
| #6126 | Performance guide                                    | `041035f` (`docs/performance.md` — indexing, EXPLAIN, caches, pool, metrics)                     |
| #6096 | Production migration documentation                   | `fdaccbf` (`docs/migrations.md` — rollout ritual, classification, advisory lock)                 |
| #4170 | Containerized local dev docs                         | `041035f` (`docs/docker-compose.md` — production stack, bundled mode, monitoring overlay)        |
| #6176 | docker-compose example                               | `041035f` (same — fully worked compose with healthcheck + volumes)                               |
| #4239 | Secure TLS setup in deploy guides                    | `c4abb9a` (`docs/production-deployment.md` — hot-reload + cert-expiry gauge)                     |
| #1163 | EdgeQL cheat sheet                                   | `32f5e96` (`docs/edgeql-cheatsheet.md` — one-page reference)                                     |
| #1021 | Authentication is under documented                   | `5d3a0b1` (`docs/auth.md` — TOTP/magic-link/recovery/WebAuthn/anonymous/OAuth/branding/webhooks) |
| #4787 | Document undocumented config options                 | `c4abb9a` (`docs/server.md` — full ServerConfig + env-var/`disc.toml` matrix)                    |
| #2230 | Update migration workflow docs                       | `fdaccbf` (`docs/migrations.md` — create→review→apply→rollback narrative)                        |
| #8273 | Connection resolution algorithm                      | `c4abb9a` (`docs/server.md#connection-resolution` — `resolveDsn` order documented)               |
| #8421 | Document `GEL_SERVER_PASSWORD_HASH` equivalent       | `5d3a0b1` (`docs/auth.md#admin-password-management` — bcrypt + `disc admin set-password`)        |
| #5234 | Instance-level config via CLI args / env             | `fe1738b` (`DISC_REQUIRE_AUTH`/`READ_ONLY`/`TRUST_PROXY`/`SHUTDOWN_DRAIN_TIMEOUT`/`BINARY_PORT`) |
| #7563 | All public CLI flags via env vars                    | `fe1738b` (companion to #5234 — full env-var parity audit)                                       |
| #4547 | `DISC_TLS_CERT_ENV` / `_KEY_ENV` indirection         | `fe1738b` (`resolveTlsMaterial` materializes PEM env strings to 0600 temp files)                 |
| #4943 | Document new features (CHANGELOG)                    | `4080cb0` (Keep-a-Changelog format + `[Unreleased]` section + auto-extendable per-tag promotion) |
| #6094 | Programmatic reimplementing migrations guide         | `7dcd1a9` (`docs/migrations.md#programmatic-api` — Lifecycle, ConnectionPool injection, embed)   |
| #4334 | Brew update messaging                                | follow-on of #3437 (no Disc Homebrew formula yet — pinned)                                       |
| #3733 | Skip prompts for first migration                     | PIN — Disc has no interactive migration prompts (classifier labels + non-interactive gate)       |
| #3414 | Confusing constraint-change prompts                  | PIN — same; differ emits `AlterProperty` not Drop+Create cycle                                   |

(Approx. 84 items — many ride on a single commit; cross-referenced via `git log --oneline`.)

### BUILD — sorted by leverage (security/correctness > UX > infra; S < M < L effort)

> **De-duped 2026-05-07 after Bundles I–KK closed 22 items + 12 pins.** Items shipped or pinned across Bundles 1–KK are listed in the post-Bundle-H sweep table at the top of this file (and authoritatively in `CHANGELOG.md` `[Unreleased]`). The table below enumerates only what's actually pickable now.

#### Migration & perf (5)

> **Bundle LL closed the migration-perf sub-cluster (#5322 + #5713 + #4319).**
> #5322 was a real differ bug fixed in `migration/differ.ts`; #5713 + #4319
> were structurally inapplicable and pinned in `tests/gel-divergence-pins.test.ts`.

| #             | Title                               | Category            | Why pickable                                                   | Effort |
| ------------- | ----------------------------------- | ------------------- | -------------------------------------------------------------- | ------ |
| #6083         | Advanced migration workflows        | docs                | Branches, squashing, partial application — narrative + recipes | M      |
| #1772 / #1461 | RFC1000 migration features          | migration           | Audit our diff generator vs. RFC                               | L      |
| #5190         | Backport migration rewrites         | migration           | We don't have versioned rewrites yet                           | M      |
| #3761         | "Compact" migrations / push command | migration, devtools | Already partially in `767afb7`; finish push                    | S      |
| #6697         | In-place major version upgrades     | migration           | Big — port pg_dump/pg_restore based path                       | L      |

#### Auth & access (2)

> **Bundle MM closed the auth-semantics sub-cluster (#7103 + #5504 + #8811).**
> #7103 was a real FK gap on `webauthn_challenges` fixed in `auth/provider.ts`;
> #5504 + #8811 were structurally inapplicable and pinned in
> `tests/gel-divergence-pins.test.ts`.

| #     | Title                             | Category        | Why pickable                                             | Effort |
| ----- | --------------------------------- | --------------- | -------------------------------------------------------- | ------ |
| #6432 | Access policy management features | auth, devtools  | UI-side schema browser shows them; add introspection API | M      |
| #8909 | In-place upgrades & auth update   | auth, migration | Tied to #6697                                            | M      |

#### DB / perf / engine (3)

> **Bundle OO closed the DB/engine correctness sub-cluster (#5641 + #4215 + #2204).**
> All three are structurally addressed in Disc — pins documented in
> `tests/gel-divergence-pins.test.ts`. #4215 carries a TODO marker for a
> future fix to detect type-level `extending` changes in the differ.

| #             | Title                            | Category   | Why pickable                                    | Effort |
| ------------- | -------------------------------- | ---------- | ----------------------------------------------- | ------ |
| #3510         | External UUIDs                   | db         | Add `id` override at schema level               | M      |
| #5505 / #6517 | Access policies slow performance | auth, perf | Profile `access/evaluator.ts` once usage scales | M      |
| #1634         | Reduce cost of new connections   | perf       | Connection pool warm-cache audit                | M      |

#### CLI / devtools (2)

> **Bundle NN closed the CLI/devtools sub-cluster (#5911 + #3406 + #2651).**
> #5911 + #3406 shipped real env-var/API additions; #2651 was structurally
> handled by Disc's project-context model and pinned in
> `tests/gel-divergence-pins.test.ts`.

| #     | Title                               | Category      | Why pickable                                            | Effort |
| ----- | ----------------------------------- | ------------- | ------------------------------------------------------- | ------ |
| #9117 | gel-py command on Windows 11        | cli           | Cross-platform CLI — verify we handle Windows correctly | M      |
| #4308 | Modify stdlib during minor upgrades | migration, db | Standard library versioning story                       | M      |

#### Cloud / infra (5)

| #     | Title                        | Category        | Why pickable                           | Effort |
| ----- | ---------------------------- | --------------- | -------------------------------------- | ------ |
| #4901 | Docker latest tag mismatch   | cloud           | Fix our release CI tagging             | S      |
| #5699 | Push images to GHCR          | cloud, devtools | Already in GHCR? Verify                | S      |
| #4806 | PR preview environments      | cloud           | Uffizzi-style; nice-to-have            | M      |
| #6598 | Multi-tenant logging         | cloud           | Add tenant tag to log lines            | M      |
| #3534 | Listen on multiple TCP ports | infra           | Niche; only when self-host requests it | M      |

#### Docs (3)

| #                     | Title                              | Category | Why pickable                   | Effort |
| --------------------- | ---------------------------------- | -------- | ------------------------------ | ------ |
| #6127                 | Test guide                         | docs     | We have tests; write the guide | S      |
| #6119 / #5820 / #5819 | Document UI / UI button visibility | docs     | UI documentation pass          | S      |
| #7382                 | Improved docs search               | docs     | Search infra; deferrable       | M      |

#### Stretch (2)

| #     | Title              | Category    | Why pickable                                 | Effort |
| ----- | ------------------ | ----------- | -------------------------------------------- | ------ |
| #648  | SQLite back-end    | db, storage | Stretch — Disc is Postgres-first; deferrable | L      |
| #7724 | Extension upgrades | migration   | We have an extension model already           | M      |

**Pickable: ~21 items** (Bundles LL + MM + NN + OO closed 4 fixes + pinned 8 across migration-perf, auth-semantics, CLI/devtools, and DB/engine). Highest-leverage clusters:

1. **Cloud/infra** — #4901 docker latest tag + #5699 GHCR images (release-CI polish)
2. **Migration robustness** — #5190 backport rewrites + #3761 push command + #6697 in-place upgrades (operator-ergonomics)
3. **Auth/access** — #6432 access-policy introspection API + #8909 in-place auth upgrades (admin UI surface)

### SKIP — not applicable to Disc

| #                                                                                                                                                                                                                                                                                                                         | Title                                                 | Reason                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| #8716                                                                                                                                                                                                                                                                                                                     | OAuth `IdentityCreated` not fired in Gel              | Gel auth-extension bug; our webhook impl already fires it (`47e6f38`)                                       |
| #8640                                                                                                                                                                                                                                                                                                                     | OIDC provider docs                                    | Disc has its own docs; cherry-pick examples not the doc commit                                              |
| #8422                                                                                                                                                                                                                                                                                                                     | Gel Python `WebAuthnFactor` keyword bug               | Python-impl-specific; our TS impl unaffected                                                                |
| #8909                                                                                                                                                                                                                                                                                                                     | Gel auth in-place upgrade bug                         | Tied to Gel's Python migration tooling; our migration tracker is fresh                                      |
| #8273                                                                                                                                                                                                                                                                                                                     | Connection resolution algorithm docs                  | Documented in our `lib/project-context.ts`; minor SKIP                                                      |
| #8421                                                                                                                                                                                                                                                                                                                     | `GEL_SERVER_PASSWORD_HASH` docs                       | Gel-specific env var; document `DISC_*` instead — covered above                                             |
| #8186 (DONE)                                                                                                                                                                                                                                                                                                              | OTC                                                   | —                                                                                                           |
| #8517 / #8500                                                                                                                                                                                                                                                                                                             | Gel SDL migration loader bugs                         | Our parser is independent; spot-check, then SKIP if green                                                   |
| #8909 / #8790                                                                                                                                                                                                                                                                                                             | Gel cloud-specific upgrades                           | Cloud-only                                                                                                  |
| #6948                                                                                                                                                                                                                                                                                                                     | Cloud key-specific rights                             | Cloud-only                                                                                                  |
| #8539                                                                                                                                                                                                                                                                                                                     | Gel cloud auth                                        | Cloud-only                                                                                                  |
| #5842 / #5755 / #4901 / #5699 / #5518                                                                                                                                                                                                                                                                                     | Gel Docker/cloud bugs                                 | Mostly Disc-fresh, minor verification                                                                       |
| #6598                                                                                                                                                                                                                                                                                                                     | Multi-tenant logging                                  | Stretch — pickable not skip; moved to BUILD                                                                 |
| #5005                                                                                                                                                                                                                                                                                                                     | Roadmap webpage                                       | We have our own                                                                                             |
| #5158 / #4022 / #3969 / #2828 / #3479 / #2187 / #2940 / #2847                                                                                                                                                                                                                                                             | Gel-Python project-init bugs                          | Our `cli/init.ts` is fresh — spot test, then SKIP                                                           |
| #6126 / #6096 / #6094 / #6083 / #6119 / #6127 / #6648 / #6122 / #6112 / #6120 / #4787 / #4943 / #4787 / #2401 / #5023 / #2230 / #5644 / #4239 / #4170 / #1163 / #1613 / #1276 / #6547 / #5097 / #4943 / #5820 / #5819 / #5097 / #61 / #357 / #184 / #39 / #4177 / #6622 / #4943 / #2206 / #2157 / #3565                   | "Documentation of X"                                  | Disc maintains its own docs at `/docs/`; cherry-pick examples as inspiration but SKIP the underlying issues |
| #7297                                                                                                                                                                                                                                                                                                                     | `configure branch` logs wrong message                 | Gel-only branching model — Disc uses different model                                                        |
| #7193                                                                                                                                                                                                                                                                                                                     | Patch-old-version pre-release tests                   | Gel internal CI                                                                                             |
| #7150                                                                                                                                                                                                                                                                                                                     | 5.0-beta-to-beta upgrade restore protocol             | Gel internal                                                                                                |
| #7095 / #7056 / #6916 / #5497 / #5492 / #5483 / #5408 / #5114 / #2306 / #2307 / #2314 / #2296 / #2089 / #2085 / #1987 / #1895 / #1865 / #1841 / #1681 / #1736                                                                                                                                                             | Gel-specific migration internal bugs                  | Spot-test, mostly SKIP                                                                                      |
| #6831                                                                                                                                                                                                                                                                                                                     | Single-user mode password                             | Gel-specific deployment mode; our model differs                                                             |
| #6673                                                                                                                                                                                                                                                                                                                     | GraphiQL auth method                                  | We don't ship Gel's GraphiQL-as-tunnel; our admin UI handles it                                             |
| #6543                                                                                                                                                                                                                                                                                                                     | New SDL loading strategy                              | Architectural for Gel; we already loaded SDL differently — SKIP                                             |
| #5641 / #5132 / #5060 / #4789 / #4766 / #4406 / #4343 / #4215 / #4192 / #4191 / #4186 / #5132 / #5497 / #5408 / #2834 / #3522 / #3521                                                                                                                                                                                     | Gel migration internal failures                       | Most are Gel-Python migration codegen bugs; verify our equivalent passes                                    |
| #6464                                                                                                                                                                                                                                                                                                                     | (not in our list)                                     | —                                                                                                           |
| #4408                                                                                                                                                                                                                                                                                                                     | Pre-commit/CI                                         | Pickable; moved to BUILD                                                                                    |
| #4806                                                                                                                                                                                                                                                                                                                     | PR preview envs                                       | Disc has its own CI; defer                                                                                  |
| #4334                                                                                                                                                                                                                                                                                                                     | brew update messaging                                 | BUILD                                                                                                       |
| #4253                                                                                                                                                                                                                                                                                                                     | Musl Linux                                            | We bundle Postgres binaries; verify musl path                                                               |
| #1129                                                                                                                                                                                                                                                                                                                     | Superuser CLI                                         | BUILD                                                                                                       |
| #1218                                                                                                                                                                                                                                                                                                                     | `\d` REPL fix                                         | BUILD                                                                                                       |
| #5234                                                                                                                                                                                                                                                                                                                     | Instance-level config via CLI                         | BUILD                                                                                                       |
| #5386                                                                                                                                                                                                                                                                                                                     | `EDGEDB_SERVER_ADMIN_UI` env var                      | Gel-specific; we have our own knob                                                                          |
| #2643                                                                                                                                                                                                                                                                                                                     | `EDGEDB_SERVER_*` prefix uniformity                   | Gel-specific; we use `DISC_*` — already uniform                                                             |
| #5302                                                                                                                                                                                                                                                                                                                     | Prometheus in remote-compiler mode                    | Gel architecture-specific                                                                                   |
| #1454                                                                                                                                                                                                                                                                                                                     | Split build/test CI jobs                              | Gel internal CI                                                                                             |
| #1832                                                                                                                                                                                                                                                                                                                     | Could not compile `edgeql-rust`                       | Gel Rust crate                                                                                              |
| #1819                                                                                                                                                                                                                                                                                                                     | Event sourcing projections                            | Architectural fork — track separately                                                                       |
| #1794                                                                                                                                                                                                                                                                                                                     | Mark optional types in AST                            | Gel codebase                                                                                                |
| #1752                                                                                                                                                                                                                                                                                                                     | Rename string functions                               | Gel API stability decision                                                                                  |
| #5805                                                                                                                                                                                                                                                                                                                     | Tests for the patch system                            | Gel-internal                                                                                                |
| #5781                                                                                                                                                                                                                                                                                                                     | dev/prod workflow guide                               | docs — pickable as BUILD                                                                                    |
| #5759                                                                                                                                                                                                                                                                                                                     | (not in 8-10 band)                                    | —                                                                                                           |
| #5363                                                                                                                                                                                                                                                                                                                     | GraphQL back-endless mode docs                        | We don't have this mode                                                                                     |
| #5159                                                                                                                                                                                                                                                                                                                     | (n/a)                                                 | —                                                                                                           |
| #4313                                                                                                                                                                                                                                                                                                                     | Disable GraphQL introspection in prod                 | We don't ship GraphQL introspection by default                                                              |
| #4322                                                                                                                                                                                                                                                                                                                     | N+1 in GraphQL                                        | Compiler-level — only matters if we ship GraphQL ext                                                        |
| #4151 / #4136 / #4219 / #6133                                                                                                                                                                                                                                                                                             | Access policy semantics edge cases                    | We rebuilt this; verify, then mostly SKIP                                                                   |
| #4079                                                                                                                                                                                                                                                                                                                     | Link project to multiple dirs                         | Gel-Python project model                                                                                    |
| #4052 / #3638 / #3454 / #3477 / #3428 / #4409                                                                                                                                                                                                                                                                             | Cloud-platform deploy bugs                            | Verify each platform; mostly external                                                                       |
| #3896                                                                                                                                                                                                                                                                                                                     | Socket activation                                     | Stretch infra                                                                                               |
| #3871                                                                                                                                                                                                                                                                                                                     | Disable TLS renegotiation                             | Already off in modern Deno TLS — verify                                                                     |
| #3774                                                                                                                                                                                                                                                                                                                     | Expose `gen_random_uuid()`                            | Done at `a067c97`                                                                                           |
| #3733                                                                                                                                                                                                                                                                                                                     | Skip prompts for first migration                      | Pickable as BUILD; small                                                                                    |
| #3609                                                                                                                                                                                                                                                                                                                     | TS query-builder + pnpm                               | Verify our codegen plays with pnpm                                                                          |
| #3562                                                                                                                                                                                                                                                                                                                     | UnknownIssuer cert                                    | Document trust-store steps                                                                                  |
| #3502                                                                                                                                                                                                                                                                                                                     | Composite exclusive constraint KeyError               | Gel-specific; verify                                                                                        |
| #3446                                                                                                                                                                                                                                                                                                                     | Blog RSS feed                                         | We don't have a blog yet                                                                                    |
| #3414                                                                                                                                                                                                                                                                                                                     | Confusing constraint-change prompts                   | Pickable as BUILD; small                                                                                    |
| #3208                                                                                                                                                                                                                                                                                                                     | Migration creation fails                              | BUILD                                                                                                       |
| #3170                                                                                                                                                                                                                                                                                                                     | Misleading disconnect log in CLI                      | Pickable                                                                                                    |
| #3131                                                                                                                                                                                                                                                                                                                     | Generate Prometheus docs                              | docs                                                                                                        |
| #3019                                                                                                                                                                                                                                                                                                                     | Query playground                                      | We have admin UI query editor                                                                               |
| #2948                                                                                                                                                                                                                                                                                                                     | Test mode connecting to existing instance             | Pickable                                                                                                    |
| #2882                                                                                                                                                                                                                                                                                                                     | ANTLR4 grammar                                        | We use a hand-rolled parser; SKIP                                                                           |
| #2848                                                                                                                                                                                                                                                                                                                     | NoneType auth method ISE                              | Python; SKIP                                                                                                |
| #2673                                                                                                                                                                                                                                                                                                                     | Anchor/sticky doc links                               | docs                                                                                                        |
| #2651                                                                                                                                                                                                                                                                                                                     | Named instance DX                                     | BUILD                                                                                                       |
| #4715 / #4697 / #4659 / #4635 / #4586 / #4408 / #4253 / #4289 / #4022 / #3969 / #2828 / #2187 / #1218 / #5602 / #5532 / #5187 / #5162 / #4801 / #5158 / #5480                                                                                                                                                             | CLI / install bugs                                    | We have a fresh CLI; verify-then-SKIP for most                                                              |
| #5043                                                                                                                                                                                                                                                                                                                     | Coordinated release publishing                        | We do this already                                                                                          |
| #2549 / #2547 / #2409 / #2380 / #2328 / #2314 / #2307 / #2306 / #2296 / #2089 / #2085 / #1987 / #1895 / #1865                                                                                                                                                                                                             | Gel migration bugs                                    | Verify-then-SKIP                                                                                            |
| #2243 / #2230 / #2206 / #2157 / #2078 / #2071 / #2204                                                                                                                                                                                                                                                                     | Migration features (some DONE, some BUILD, some SKIP) | Per-issue judgment above                                                                                    |
| #1672                                                                                                                                                                                                                                                                                                                     | (n/a)                                                 | —                                                                                                           |
| #1490 / #1489 / #1486 / #1485 / #1461 / #1325 / #1276 / #1218 / #1163 / #1147 / #1119 / #1030 / #1023 / #1021 / #967 / #930 / #893 / #859 / #846 / #838 / #757 / #725 / #720 / #673 / #655 / #648 / #631 / #594 / #497 / #465 / #357 / #237 / #187 / #184 / #152 / #146 / #135 / #120 / #80 / #61 / #41 / #39 / #37 / #12 | Older items                                           | Most map to BUILD (small) or already DONE; SKIP otherwise                                                   |

(SKIP rationale per category, summary: ~120 items where the issue is either Gel-Python-specific, Gel-Rust-specific, EdgeDB-Cloud-specific, documentation-of-Gel, or Gel-internal-tooling. Disc gets the benefit of a fresh implementation and doesn't inherit the bug.)

### DROP — upstream Gel rejected (closed `not_planned`)

| #     | Title                             | Why dropped                                                                                                                       |
| ----- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| #7482 | Disable new sign-ups per provider | Gel rejected; we kept aligned, then reversed at `1aa19c5` (documented `allowRegistration` use case) — effectively partially BUILD |
| #7341 | CAPTCHA in auth UI                | Gel rejected; we shipped opt-in CAPTCHA at `314634b` despite that — Disc's stance here diverges                                   |

(Only 2 confirmed DROPs in the high-relevance band; we re-shipped both because Disc's threat model differs.)

## Medium Relevance (score 5-7) — 789 issues, category-level rules

Sample: 40 items inspected across categories at lines 263-460, 700-900, 1000-1057.

### Rules by category

- **auth** (medium, ~80 items): mostly SCRAM/OAuth/PKCE edge cases. Most are Gel-Python implementation bugs that don't apply to Disc's TS auth. **Default: SKIP**, but cherry-pick anything that turns out to be a protocol-level concern (e.g. #3639 SCRAM concurrency, #5862 `current_role` query function). **Pickable in BUILD: ~10 items.**

- **migrations** (medium, ~250 items): the biggest medium category. Most items are Gel-internal migration-tooling bugs (DDL generation off-by-one, type-system edge cases, ISEs in `gel migration create`). **Default: SKIP** because Disc's migration engine was rebuilt and doesn't inherit them. Use the bug list as a fixture set: when our diff engine fails on schema X, check if Gel had a corresponding ticket. **Pickable: ~5-10 features (auto-rename indexes #8016, RESET SCHEMA #4351, etc.).**

- **database-core** (medium, ~150 items): EdgeDB-internal compiler/query-engine bugs. **Default: SKIP**. Disc's compiler is fresh; we don't inherit Gel's compiler bugs. Pick only items describing a _feature_ (e.g. #6480 two-phase commit, #6527 schema-level exclusive constraints).

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

| #                     | Title                                      | Why                                                       |
| --------------------- | ------------------------------------------ | --------------------------------------------------------- |
| #5862                 | Function to get current authenticated role | We shipped RBAC; this is the natural API completion       |
| #4596                 | Cursor-based pagination                    | UI viewer + GraphQL ext both want it                      |
| #4941                 | Initial FTS take (RFC 1015)                | Future feature; track for v2                              |
| #4322                 | Compiler-level GraphQL N+1                 | Only relevant once GraphQL ext is hot                     |
| #6940                 | JSON-schema query generator                | Adoption lever for cross-language clients                 |
| #1610                 | Partial constraints/indexes                | Real DB feature; pick when needed                         |
| #5066                 | Multi-sequence support                     | Stretch                                                   |
| #3916                 | CDC / logical replication                  | Big — but huge adoption lever                             |
| #3774                 | Expose `gen_random_uuid`                   | Done at `a067c97` (covered by std::* crypto)              |
| #6884                 | DB config in migrations                    | Real feature gap — connect to migration engine            |
| #8625 / #8624         | Reranking / hybrid search                  | Vector ext territory; future                              |
| #3534                 | Listen on multiple ports                   | Niche; only when self-host requests it                    |
| #5921                 | (no — not in list)                         | —                                                         |
| #4151 / #4136 / #4219 | Access policy edge cases                   | Audit our `access/evaluator.ts` against these             |
| #5862                 | (above)                                    |                                                           |
| #6480                 | Two-phase commit                           | Future distributed-tx story                               |
| #6527                 | Schema-level exclusive                     | We handle exclusive constraints; verify schema-level form |
| #8016                 | Auto-rename indexes in migrations          | DX win; probably small                                    |
| #3759                 | Custom shorter IDs                         | Not for v1; stretch                                       |

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
