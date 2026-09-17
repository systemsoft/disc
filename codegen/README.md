# Codegen

Schema-driven client generator for Disc. Reads the EdgeQL schema and produces typed interfaces, insert/update types, enum types, query builders, and a typed client. Built on a language-neutral intermediate representation (IR) so the same pipeline targets multiple languages (TypeScript today, Rust). Run via `disc codegen` or programmatically.

## Import

```typescript
import {
  DEFAULT_CONFIGS,
  generateTypeScript,
  writeGeneratedFiles
} from "disc/codegen/mod.ts";

import type {
  CodegenConfig,
  CodegenResult,
  GeneratedFile,
  TypeMapping
} from "disc/codegen/mod.ts";
```

## Usage

### Programmatic

```typescript
import { generateTypeScript, writeGeneratedFiles } from "disc/codegen/mod.ts";
import type { Schema } from "disc/compiler/context.ts";

const schema: Schema = /* parsed from SDL */;

const result = generateTypeScript(schema, {
  includeClient: true,
  includeQueryBuilders: true,
  outputDir: "./generated",
  target: "client"
});

// Write generated files to disk
await writeGeneratedFiles(result, ".");
```

### Via CLI

```bash
disc codegen                  # Generate with default config
disc codegen --output ./src   # Custom output directory
```

## Configuration

```typescript
interface CodegenConfig {
  formatOutput: boolean; // format generated code (default: true)
  includeClient: boolean; // generate typed client class (default: true)
  includeMutations: boolean; // generate mutation helpers (default: true)
  includeQueryBuilders: boolean; // generate query builder classes (default: true)
  interfaceSuffix?: string; // suffix for generated interface names
  outputDir: string; // output directory (default: "./generated")
  schemaSource: string; // SDL schema file path (default: "./schema.disc")
  target: "client" | "server" | "both"; // generation target (default: "client")
  typePrefix?: string; // prefix for generated type names
}
```

### Preset Configurations

```typescript
import { DEFAULT_CONFIGS } from "disc/codegen/mod.ts";

// Client-side (query builders + client + mutations)
const clientConfig = DEFAULT_CONFIGS.client();

// Server-side (types only, no query builders or client)
const serverConfig = DEFAULT_CONFIGS.server();

// Both (everything)
const bothConfig = DEFAULT_CONFIGS.both();
```

## Generated Output

Running codegen produces four files:

### `types.ts` -- Type Definitions

Contains TypeScript interfaces for each object type in the schema, enum types for scalar enums, and utility types for insert, update, and filter operations.

Given this SDL schema:

```
module default {
  scalar type Status extending enum<Active, Inactive, Pending>;

  type User {
    created_at: datetime {
      default := datetime_current();
      readonly := true;
    };
    required email: str {
      constraint exclusive;
    };
    required name: str;
    multi posts: Post;
    status: Status;
  };

  type Post {
    required author: User;
    required body: str;
    created_at: datetime {
      default := datetime_current();
    };
    required title: str;
  };
};
```

The generator produces:

```typescript
/**
 * Status enum type from EdgeQL schema
 */
export type Status = "Active" | "Inactive" | "Pending";

/**
 * User type from EdgeQL schema
 * Table: user
 */
export interface User {
  /** Unique identifier */
  id: string;
  /**
   * datetime
   * @readonly
   * @default
   */
  created_at?: Date | null;
  /**
   * str (required)
   * @constraint exclusive
   */
  email: string;
  /** str (required) */
  name: string;
  /** Link to Post (many) */
  posts?: Post[];
  /** Status */
  status?: Status | null;
}
```

### Insert and Update Types

Insert types exclude `id` (auto-generated), computed properties, and readonly properties with defaults. Properties with defaults are optional even if marked `required` in the schema.

```typescript
export interface UserInsert {
  email: string; // required, no default
  name: string; // required, no default
  status?: Status; // optional
}
```

Update types exclude `id`, computed properties, and readonly properties. All fields are optional.

```typescript
export interface UserUpdate {
  email?: string;
  name?: string;
  status?: Status;
}
```

### FilterVars Types

Typed variables for the query builder's `count()` method, which still takes a raw EdgeQL condition string. All fields are optional with an index signature for flexibility. `filter()` does not use these -- it takes a structured `Filter` object (below).

```typescript
export interface UserFilterVars {
  created_at?: Date;
  email?: string;
  id?: string;
  name?: string;
  status?: Status;
  [key: string]: unknown;
}
```

### Filter and Select Types

`Filter` is the argument type for the query builder's `filter()` method. Every scalar property accepts either a bare value (compiled to `=`) or an operator object; every link accepts the target type's own `Filter`, which compiles to a path traversal. The reserved keys `select`, `order_by`, `limit`, and `offset` shape and bound the result set.

```typescript
export interface UserFilter {
  id?: string | Op<string>;
  created_at?: Date | OrdOp<Date>;
  email?: string | StrOp;
  name?: string | StrOp;
  status?: Status | Op<Status>;
  posts?: PostFilter;
  select?: UserSelect;
  order_by?: string | string[];
  limit?: number;
  offset?: number;
}
```

`Select` is the shape descriptor. Scalars are booleans; links take either a boolean or the target's own `Select` for nested shaping, with an optional `filter` / `order_by` that narrows and orders _that link’s_ set.

```typescript
export interface UserSelect {
  "*"?: boolean;
  filter?: UserFilter;
  order_by?: string | string[];
  id?: boolean;
  created_at?: boolean;
  email?: boolean;
  name?: boolean;
  status?: boolean;
  posts?: boolean | PostSelect;
}
```

Computed properties appear in `Select` and `FilterVars`, but in `Filter` only when their type can be inferred -- computed named tuples become a nested operator object (`counts?: { videos?: number | OrdOp<number> }`); anything else is omitted rather than emitted as an unusable `unknown` field.

### Operator Helpers

Three shared helpers are emitted once per `types.ts`. Which one a property gets is driven by its EdgeQL type: `str` gets `StrOp`, ordered scalars (`int*`, `float*`, `decimal`, `bigint`, `datetime`, `duration`, `cal::*`) get `OrdOp<T>`, everything else gets `Op<T>`.

```typescript
/** Equality + set operators — available on every scalar field */
export interface Op<T> {
  eq?: T;
  ne?: T;
  in?: T[];
  not_in?: T[];
}

/** Ordered operators — numbers, dates, durations */
export interface OrdOp<T> extends Op<T> {
  gt?: T;
  gte?: T;
  lt?: T;
  lte?: T;
}

/** String operators — adds pattern matching to ordered string ops */
export interface StrOp extends OrdOp<string> {
  like?: string;
  ilike?: string;
}
```

### JSDoc Constraint Documentation

Properties with constraints, readonly flags, or defaults get JSDoc annotations:

```typescript
/**
 * str (required)
 * @readonly
 * @default
 * @constraint exclusive
 * @constraint max_len_value(255)
 */
email: string;
```

### `queries.ts` -- Query Builders

One query builder class per object type with methods for common operations:

```typescript
class UserQueryBuilder {
  constructor(private client: DiscClient) {}

  async count(condition?: string, variables?: UserFilterVars): Promise<number>;
  async delete(id: string): Promise<User>;
  async filter(filter: FilterArg<UserFilter>): Promise<User[]>;
  async insert(data: UserInsert): Promise<User>;
  async select(shape?: string): Promise<User[]>;
  async selectById(id: string, shape?: string): Promise<User | null>;
  async update(id: string, data: UserUpdate): Promise<User>;
}
```

`filter()` takes a structured object, not an EdgeQL condition string. `FilterArg<T>` is `Expr | T` -- either the type's `Filter` object or an expression built with the `and` / `or` / `not` combinators re-exported from the generated `index.ts`. The object is compiled to EdgeQL by `compileFilter()` from the SDK, with every value bound as a query parameter:

```typescript
// Bare values compile to `=`; operator objects to their operator
await client.user.filter({ email: "ada@example.com" });
await client.user.filter({
  name: { ilike: "%ada%" },
  status: { in: ["Active"] }
});

// Links traverse: compiles to `filter .author.name = <str>$p0`
await client.post.filter({ author: { name: "Ada" } });

// select / order_by / limit / offset shape and bound the result set
await client.user.filter({
  status: "Active",
  select: { name: true, email: true, posts: { title: true } },
  order_by: ["-created_at", "name"],
  limit: 20,
  offset: 40
});

// Combinators for anything the object shape can't express
import { or } from "./dbschema/disc-client/index.ts";
await client.user.filter(or({ name: "Ada" }, { email: "ada@example.com" }));
```

Omitting `select` defaults the shape to `{ * }`, which covers stored properties only -- computed properties are opt-in and must be named explicitly.

Insert and update methods use type-aware EdgeQL casts (e.g., `<str>`, `<int32>`, `<datetime>`) based on the schema property types.

Single links appear in the `Insert`/`Update` types as the target object's UUID (`string`) and are cast as `<uuid>`, so `client.post.insert({ title, author: userId })` assigns the link directly.

Multi links (junction-backed) are typed as arrays of target UUIDs:

- **Insert** — `link: string[]` assigns the full set:
  ```typescript
  await client.user.insert({ name: "Ada", teams: [teamId1, teamId2] });
  ```
- **Update (replace)** — `link: string[]` replaces the whole set:
  ```typescript
  await client.user.update(userId, { teams: [teamId2, teamId3] });
  ```
- **Update (delta)** — `link: { add?: string[]; remove?: string[] }` adds/removes
  members without touching the rest of the set:
  ```typescript
  await client.user.update(userId, { teams: { add: [teamId1] } });
  await client.user.update(userId, { teams: { remove: [teamId2] } });
  ```

Computed links remain excluded from `Insert`/`Update`.

### `client.ts` -- Typed Client

Extends the SDK `DiscClient` with query builder properties:

```typescript
import { DiscClient as BaseClient } from "../sdk/mod.ts";

class DiscClient extends BaseClient {
  readonly post: PostQueryBuilder;
  readonly user: UserQueryBuilder;

  constructor(config?: DiscClientConfig) {
    super(config);

    this.post = new PostQueryBuilder(this);
    this.user = new UserQueryBuilder(this);
  }
}
```

### `index.ts` -- Barrel File

Re-exports everything from `types.ts`, `queries.ts`, and `client.ts`.

## Type Mappings

EdgeQL types are mapped to TypeScript types:

| EdgeQL Type               | TypeScript Type | Nullable             |
| ------------------------- | --------------- | -------------------- |
| `str`                     | `string`        | `string \| null`     |
| `bool`                    | `boolean`       | `boolean \| null`    |
| `int16`, `int32`, `int64` | `number`        | `number \| null`     |
| `float32`, `float64`      | `number`        | `number \| null`     |
| `decimal`                 | `number`        | `number \| null`     |
| `uuid`                    | `string`        | `string \| null`     |
| `datetime`                | `Date`          | `Date \| null`       |
| `duration`                | `string`        | `string \| null`     |
| `bytes`                   | `Uint8Array`    | `Uint8Array \| null` |
| `json`                    | `unknown`       | `unknown \| null`    |
| `cal::local_datetime`     | `Date`          | `Date \| null`       |
| `cal::local_date`         | `string`        | `string \| null`     |
| `cal::local_time`         | `string`        | `string \| null`     |

SQL type names (`text`, `integer`, `boolean`, etc.) are also supported for backward compatibility and mapped through to their EdgeQL equivalents.

## Architecture

Codegen is built on a language-neutral **intermediate representation (IR)**. A
frontend transforms the schema into the IR; emitters turn the IR into source for
a target language. Adding a language is "write one emitter" -- no frontend change.

```
schema (Context.Schema)
   |  schemaToIR()        codegen/schema-to-ir.ts
   v
  IR (CodegenIR)          codegen/ir.ts
   |  emitTypeScript()    codegen/emit-typescript.ts  -> interfaces.ts / queries.ts / client.ts / index.ts
   +- emitRust()          codegen/emit-rust.ts        -> a Cargo crate (structs, builders, std-only HTTP/JSON client)
```

`generateTypeScript()` is the production entry point and runs schema -> IR ->
TypeScript. The IR carries denormalized insert/update/filter shapes, first-class
module namespaces, and wire-complete cardinality, so emitters are near-mechanical
pretty-printers. The TypeScript output is regression-guarded by golden snapshots
(`codegen/emit-typescript.test.ts`); the Rust emitter by an offline `cargo build`
gate (`codegen/emit-rust.test.ts`).
