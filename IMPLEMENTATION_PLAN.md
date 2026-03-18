# Disc Database — Implementation Plan

> Last Updated: 2026-03-17
> Status: Core Complete — Future Phases

## Completed Work (Phases 1-9)

All core database integration and production infrastructure is complete. 724 tests passing.

- Phase 1: Fix core execution path (compiler, type errors)
- Phase 2: Database integration (real PG execution, connection pooling, transactions)
- Phase 3: CLI integration (SchemaManager, migrate, serve, codegen wiring)
- Phase 4: Query compilation integration (built-in functions, backlinks, schema reload)
- Phase 5: Auth system integration (JWT, PgDatabaseAdapter, server lifecycle)
- Phase 6: Access policies integration (SDL adapter, RLS, auth-access bridge)
- Phase 6b: Real PG access policy E2E tests
- Phase 7: Query compilation cache and observability (LRU cache, per-query metrics, slow query logging)
- Phase 8: Production hardening (error propagation, graceful shutdown, timeouts, health checks)
- Phase 9: Production infrastructure (rate limiting, structured logging, TLS, metrics, EXPLAIN cache, deployment guide)

---

## Stage 10: Client SDK

**Goal**: TypeScript client library for Disc
**Success Criteria**: Published package with type-safe queries
**Status**: Not Started

### Tasks

- [ ] Design client API surface (`createClient`, `query`, `execute`, `transaction`)
- [ ] Implement connection handling (HTTP + WebSocket)
- [ ] Add query builder with TypeScript types from `disc codegen` output
- [ ] Connection pooling and automatic retries
- [ ] Type-safe result mapping
- [ ] Publish to JSR

---

## Stage 11: Performance Benchmarking

**Goal**: Establish baselines and optimize critical paths
**Success Criteria**: Documented benchmarks, optimized hot paths
**Status**: Not Started

### Tasks

- [ ] Benchmark query compilation throughput (queries/sec)
- [ ] Benchmark connection pool under load
- [ ] Profile EdgeQL parsing for large queries
- [ ] Benchmark migration diffing for complex schemas
- [ ] Identify and optimize hot paths
- [ ] Document performance baselines

---

## Stage 12: Advanced Query Features

**Goal**: Expand EdgeQL compilation coverage
**Success Criteria**: GROUP BY, CTEs, window functions, FOR loops
**Status**: Not Started

### Tasks

- [ ] Aggregate functions and GROUP BY compilation
- [ ] WITH clauses / Common Table Expressions
- [ ] Window functions (row_number, rank, etc.)
- [ ] FOR loops and set operations
- [ ] LIMIT/OFFSET optimization
- [ ] Polymorphic queries (type intersection)

---

## Stage 13: Extension System

**Goal**: Modular extension framework
**Success Criteria**: OAuth extension working, extension install/uninstall lifecycle
**Status**: Not Started

### Tasks

- [ ] Design extension interface (install, uninstall, getFunctions, getTypes)
- [ ] OAuth 2.0 providers (Google, GitHub, Apple)
- [ ] WebAuthn / passkey support
- [ ] AI extension (`ext::ai` equivalent)
- [ ] Vector search (`pgvector` integration)
- [ ] Full-text search extension

---

## Stage 14: Operational Tooling

**Goal**: Production operations support
**Success Criteria**: Backup/restore, replication awareness
**Status**: Not Started

### Tasks

- [ ] `disc backup create` / `disc backup restore`
- [ ] Read replica connection routing
- [ ] Multi-tenancy (schema-per-tenant isolation)
- [ ] `disc pg upgrade` for major version upgrades
- [ ] Container images (Docker) and Kubernetes manifests

---

## Stage 15: Binary Protocol

**Goal**: Gel client compatibility (stretch goal)
**Success Criteria**: Existing Gel TypeScript client connects to Disc
**Status**: Not Started

### Tasks

- [ ] Implement Gel binary protocol message format
- [ ] Type descriptor encoding/decoding
- [ ] SASL authentication handshake
- [ ] Test with official Gel TypeScript client

---

_This plan covers future work. See `PROJECT_STATE.md` for current status._
