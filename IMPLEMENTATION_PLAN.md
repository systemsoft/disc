# Disc Database - Implementation Plan for Production Readiness

> Last Updated: 2026-02-12
> Status: 40% Complete → Production Ready
> Estimated Timeline: 3-6 months

## Executive Summary

Disc currently has strong foundations (parsers, PostgreSQL management, UI) but cannot execute queries due to a broken compiler and mocked database operations. This plan outlines the critical path to production readiness with Gel/EdgeDB feature parity.

## Current State Assessment

### ✅ Complete (No Work Needed)

- SDL Parser (schema/): 100% with 15+ test files
- EdgeQL Parser (edgeql/): 100% with comprehensive AST
- PostgreSQL Management (postgres/): Binary lifecycle fully working
- CLI Framework (cli/): All commands implemented
- Admin UI (ui/): SvelteKit interface complete
- Binary Protocol Core (protocol/): Message parsing, SASL auth, pooling

### ⚠️ Broken/Blocked

- **EdgeQL Compiler** (compiler/): 30+ TypeScript errors, cannot execute any queries
- **Database Integration**: All operations are mocked, no real PostgreSQL execution

### ❌ Missing Entirely

- Extensions system (auth, AI, vector, GraphQL)
- Client libraries (JavaScript, Python, etc.)
- Connection pooling for database
- Transaction management
- Query optimization and caching
- Backup/restore and replication

---

## Phase 1: Fix Core Execution Path (Week 1-2)

**Goal**: Execute basic SELECT queries against real PostgreSQL
**Success Criteria**: `SELECT User { name, email }` returns real data

### Stage 1.1: Fix EdgeQL Compiler TypeScript Errors

**Priority**: CRITICAL BLOCKER
**Location**: `compiler/`
**Tests**: `compiler/*.test.ts`

```typescript
// Current errors in compiler/:
// - Missing Result type imports
// - Incorrect AST node references
// - Type mismatches in SQL generation
// - Missing error handling types
```

**Tasks**:

1. Run `deno test compiler/ --no-check` to identify all type errors
2. Fix imports and type definitions in:
   - `compiler/compiler.ts`
   - `compiler/complex-query.ts`
   - `compiler/sql.ts`
   - `compiler/sql-extensions.ts`
3. Ensure all existing tests pass
4. Add integration test for basic query compilation

### Stage 1.2: Replace Mocked Database Operations

**Priority**: CRITICAL
**Location**: `server/`, `migration/`, `lib/`
**Dependencies**: `npm:postgres` or native Deno PostgreSQL driver

**Tasks**:

1. Install PostgreSQL driver:
   ```typescript
   import postgres from "npm:postgres@3.4.3";
   // or
   import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
   ```

2. Replace mocked operations in:
   - `server/simple-edgeql-protocol.ts`: executeQuery()
   - `migration/tracker.ts`: Database operations
   - `lib/database.ts`: Connection management

3. Implement real connection string handling:
   ```typescript
   const sql = postgres({
     host: config.host,
     port: config.port,
     database: config.database,
     username: config.username,
     password: config.password,
   });
   ```

4. Test with bundled PostgreSQL instance

### Stage 1.3: Basic Query Execution Pipeline

**Priority**: HIGH
**Success Metric**: End-to-end query execution

**Pipeline**:

```
EdgeQL Query → Parser → Compiler → SQL → PostgreSQL → Result Encoding → Response
```

**Tasks**:

1. Connect compiler output to database executor
2. Implement result set mapping (SQL rows → EdgeQL shapes)
3. Handle basic types (string, int, bool, datetime)
4. Add error propagation throughout pipeline

---

## Phase 2: Connection Management & Transactions (Week 3-4)

**Goal**: Production-grade connection handling
**Success Criteria**: 1000+ concurrent connections, ACID transactions

### Stage 2.1: Connection Pooling

**Location**: `lib/connection-pool.ts` (enhance existing)
**Reference**: Already implemented for protocol, adapt for database

```typescript
interface PoolConfig {
  min: number; // 10
  max: number; // 100
  idleTimeout: number; // 30000ms
  acquireTimeout: number; // 5000ms
}
```

**Tasks**:

1. Adapt existing ConnectionPool for PostgreSQL connections
2. Implement health checks and automatic reconnection
3. Add metrics (active, idle, waiting connections)
4. Test under load (1000+ operations)

### Stage 2.2: Transaction Management

**Location**: New file `lib/transaction.ts`

```typescript
interface Transaction {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  savepoint(name: string): Promise<void>;
  execute(query: string, params: any[]): Promise<Result>;
}
```

**Tasks**:

1. Implement transaction lifecycle
2. Add savepoint support
3. Handle nested transactions
4. Implement automatic rollback on error
5. Test concurrent transactions

---

## Phase 3: Type System & Data Encoding (Week 5-6)

**Goal**: Full EdgeDB type support
**Success Criteria**: All scalar and collection types working

### Stage 3.1: Type Descriptors

**Location**: `protocol/type-descriptors.ts`
**Reference**: Research doc shows UUID mappings

```typescript
// Fundamental type UUIDs (from research):
const TYPE_IDS = {
  uuid: "00000000-0000-0000-0000-000000000100",
  str: "00000000-0000-0000-0000-000000000101",
  int16: "00000000-0000-0000-0000-000000000103",
  // ... etc
};
```

**Tasks**:

1. Implement type descriptor registry
2. Create encoders/decoders for each type
3. Handle arrays, tuples, objects
4. Support custom scalar types
5. Test with complex nested structures

### Stage 3.2: Result Encoding

**Location**: `protocol/encoder.ts`

**Tasks**:

1. Binary format encoding (EdgeDB protocol)
2. JSON encoding with proper type preservation
3. Handle NULL values correctly
4. Implement streaming for large results

---

## Phase 4: Advanced Query Features (Week 7-9)

**Goal**: Full EdgeQL language support
**Success Criteria**: Complex queries with CTEs, aggregates, window functions

### Stage 4.1: Aggregations & GROUP BY

**Location**: `compiler/aggregates.ts`

```edgeql
SELECT User {
  post_count := count(.posts),
  avg_rating := math::mean(.posts.rating)
} 
GROUP BY .department
```

**Tasks**:

1. Extend compiler for aggregate functions
2. Implement GROUP BY clause compilation
3. Add HAVING support
4. Test with complex aggregations

### Stage 4.2: Common Table Expressions (CTEs)

**Location**: `compiler/cte.ts`

```edgeql
WITH
  active_users := (SELECT User FILTER .active),
  recent_posts := (SELECT Post FILTER .created > datetime_current() - <duration>'7d')
SELECT active_users { posts := recent_posts }
```

**Tasks**:

1. Parse WITH clauses
2. Generate SQL CTEs
3. Handle recursive CTEs
4. Optimize CTE execution

### Stage 4.3: Window Functions

**Location**: `compiler/window.ts`

```edgeql
SELECT User {
  rank := row_number() OVER (ORDER BY .score DESC),
  percentile := percent_rank() OVER (PARTITION BY .department)
}
```

---

## Phase 5: Extensions System (Week 10-12)

**Goal**: Core extensions for Gel compatibility
**Success Criteria**: auth and GraphQL extensions working

### Stage 5.1: Extension Framework

**Location**: `extensions/core.ts`

```typescript
interface Extension {
  name: string;
  version: string;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  getFunctions(): FunctionDefinition[];
  getTypes(): TypeDefinition[];
}
```

### Stage 5.2: Auth Extension

**Location**: `extensions/auth/`
**Priority**: HIGH (most used extension)

**Features**:

- JWT token generation/validation
- OAuth 2.0 providers (Google, GitHub, etc.)
- Password hashing (Argon2, bcrypt)
- Session management
- Role-based access control

### Stage 5.3: GraphQL Extension

**Location**: `extensions/graphql/`
**Priority**: HIGH (API compatibility)

**Features**:

- Auto-generate GraphQL schema from EdgeDB schema
- Query/mutation resolvers
- Subscription support
- DataLoader integration

---

## Phase 6: Client Libraries (Week 13-15)

**Goal**: Official TypeScript/JavaScript client
**Success Criteria**: npm package with full query builder

### Stage 6.1: TypeScript Client

**Location**: `clients/typescript/`

```typescript
import { createClient } from "@disc/client";

const client = createClient({
  dsn: "disc://localhost:5656/mydb",
});

const users = await client.query(`
  SELECT User { name, email }
`);
```

**Features**:

- Query builder with TypeScript types
- Connection pooling
- Automatic retries
- Transaction support
- Type-safe results

---

## Phase 7: Production Features (Week 16-18)

**Goal**: Enterprise-ready features
**Success Criteria**: Production deployment capable

### Stage 7.1: Monitoring & Metrics

**Location**: `monitoring/`

- Query performance tracking
- Slow query log
- Connection metrics
- Resource usage monitoring
- Prometheus/OpenTelemetry export

### Stage 7.2: Backup & Restore

**Location**: `cli/commands/backup.ts`

```bash
disc backup create --format=binary
disc backup restore --from=backup-2024-01-01.dump
```

### Stage 7.3: Replication

**Location**: `replication/`

- Read replicas
- Failover handling
- Consistency guarantees

---

## Testing Strategy

### Unit Tests (Per Module)

- Minimum 80% code coverage
- Mock external dependencies
- Test error conditions

### Integration Tests

```typescript
// tests/integration/query-execution.test.ts
Deno.test("Execute complex query end-to-end", async () => {
  const server = await startTestServer();
  const result = await server.execute(`
    SELECT User { 
      name, 
      posts: { title, comments: { text } }
    }
  `);
  assertEquals(result.length, 10);
});
```

### Performance Tests

- Query throughput (queries/second)
- Connection pool stress test
- Large result set handling
- Memory leak detection

### Compatibility Tests

- Test with official EdgeDB clients
- Verify protocol compliance
- Schema migration compatibility

---

## Development Guidelines

### Code Organization

```
disc/
├── compiler/        # Fixed and enhanced
├── protocol/        # Complete implementation
├── extensions/      # New extension system
│   ├── auth/
│   ├── graphql/
│   └── ai/
├── clients/         # Client libraries
│   └── typescript/
├── monitoring/      # Production features
└── tests/
    ├── integration/
    ├── performance/
    └── compatibility/
```

### Commit Strategy

- One feature per PR
- All tests must pass
- Type checking must pass (`deno check`)
- Lint/format before commit
- Update CHANGELOG.md

### Error Handling

```typescript
// Always use Result type for fallible operations
function compile(query: string): Result<SQLStatement, CompileError> {
  try {
    // ...
    return { ok: true, value: statement };
  } catch (error) {
    return {
      ok: false,
      error: new CompileError(error.message, {
        line: error.line,
        column: error.column,
        suggestion: getSuggestion(error),
      }),
    };
  }
}
```

### Performance Targets

- Query parsing: < 1ms for typical queries
- Query compilation: < 5ms
- Simple query execution: < 10ms
- Connection acquisition: < 1ms
- Type encoding/decoding: < 0.1ms per field

---

## Risk Mitigation

### Technical Risks

1. **Compiler complexity**: Start with simple queries, incrementally add features
2. **PostgreSQL version compatibility**: Test with PG 14, 15, 16
3. **Performance bottlenecks**: Profile early, optimize critical paths
4. **Memory leaks**: Use pooling, implement proper cleanup

### Project Risks

1. **Scope creep**: Focus on core features first
2. **Breaking changes**: Version appropriately (0.x during development)
3. **Documentation debt**: Document as you build

---

## Success Metrics

### Phase 1 Complete

- [ ] Basic SELECT queries work
- [ ] Real data returned from PostgreSQL
- [ ] All compiler tests pass

### Phase 2 Complete

- [ ] 1000+ concurrent connections handled
- [ ] Transactions with rollback working
- [ ] Connection pool metrics available

### Phase 3 Complete

- [ ] All EdgeDB scalar types supported
- [ ] Arrays and objects properly encoded
- [ ] Binary protocol fully compatible

### Phase 4 Complete

- [ ] Aggregations and GROUP BY working
- [ ] CTEs and window functions supported
- [ ] Complex queries execute correctly

### Phase 5 Complete

- [ ] Auth extension with JWT support
- [ ] GraphQL endpoint auto-generated
- [ ] Extension installation/removal working

### Phase 6 Complete

- [ ] TypeScript client published to npm
- [ ] Query builder with full type safety
- [ ] Client connection pooling

### Phase 7 Complete

- [ ] Monitoring dashboard available
- [ ] Backup/restore tested
- [ ] Production deployment guide written

---

## Next Steps

1. **Immediate** (Today):
   - Fix compiler TypeScript errors
   - Set up PostgreSQL driver
   - Create integration test harness

2. **This Week**:
   - Complete Phase 1
   - Begin connection pooling
   - Start transaction implementation

3. **This Month**:
   - Phases 1-3 complete
   - Basic client library working
   - Performance benchmarks established

---

## Resources & References

- EdgeDB Protocol Spec: https://www.edgedb.com/docs/reference/protocol
- PostgreSQL Wire Protocol: https://www.postgresql.org/docs/current/protocol.html
- Deno PostgreSQL Driver: https://deno.land/x/postgres
- EdgeDB Source (reference): https://github.com/edgedb/edgedb
- Gel Documentation: https://docs.geldata.com

---

## Appendix: Quick Start for Contributors

```bash
# Fix compiler first
cd compiler/
deno test --no-check  # See all errors
# Fix each file's imports and types
deno test  # Verify fixes

# Test with real PostgreSQL
disc start  # Start bundled PostgreSQL
deno task dev  # Run server in dev mode

# Test query execution
echo "SELECT User { name }" | disc shell

# Run integration tests
deno test tests/integration/ --allow-all
```

---

_This plan is a living document. Update status and checkboxes as work progresses. Remove completed phases to keep focus on current work._
