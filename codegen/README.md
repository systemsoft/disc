# Codegen

TypeScript type generator for Disc. Reads the EdgeQL schema and produces typed interfaces, insert/update types, enum types, query builders, and a typed client. Run via `disc codegen` or programmatically.

## Import

```typescript
import {
  DEFAULT_CONFIGS,
  generateTypeScript,
  TypeScriptGenerator,
  writeGeneratedFiles,
} from "disc/codegen/mod.ts";

import type {
  CodegenConfig,
  CodegenResult,
  GeneratedFile,
  TypeMapping,
} from "disc/codegen/mod.ts";
```

## Usage

### Programmatic

```typescript
import { generateTypeScript, writeGeneratedFiles } from "disc/codegen/mod.ts";
import type { Schema } from "disc/compiler/context.ts";

const schema: Schema = /* parsed from SDL */;

const result = generateTypeScript(schema, {
  outputDir: "./generated",
  target: "client",
  includeQueryBuilders: true,
  includeClient: true,
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
  outputDir: string; // output directory (default: "./generated")
  schemaSource: string; // SDL schema file path (default: "./schema.esdl")
  target: "client" | "server" | "both"; // generation target (default: "client")
  typePrefix?: string; // prefix for generated type names
  interfaceSuffix?: string; // suffix for generated interface names
  includeQueryBuilders: boolean; // generate query builder classes (default: true)
  includeMutations: boolean; // generate mutation helpers (default: true)
  includeClient: boolean; // generate typed client class (default: true)
  formatOutput: boolean; // format generated code (default: true)
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

Contains TypeScript interfaces for each object type in the schema, enum types for scalar enums, and utility types for insert, update, and filter operations.

Given this SDL schema:

```
module default {
  scalar type Status extending enum<Active, Inactive, Pending>;

  type User {
    required email: str {
      constraint exclusive;
    };
    required name: str;
    created_at: datetime {
      default := datetime_current();
      readonly := true;
    };
    status: Status;
    multi posts: Post;
  };

  type Post {
    required title: str;
    required body: str;
    required author: User;
    created_at: datetime {
      default := datetime_current();
    };
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
   * str (required)
   * @constraint exclusive
   */
  email: string;
  /** str (required) */
  name: string;
  /**
   * datetime
   * @readonly
   * @default
   */
  created_at?: Date | null;
  /** Status */
  status?: Status | null;
  /** Link to Post (many) */
  posts?: Post[];
}
```

### Insert and Update Types

Insert types exclude `id` (auto-generated), computed properties, and readonly properties with defaults. Properties with defaults are optional even if marked `required` in the schema.

```typescript
export interface UserInsert {
  email: string; // required, no default
  name: string; // required, no default
  status?: Status; // optional
}
```

Update types exclude `id`, computed properties, and readonly properties. All fields are optional.

```typescript
export interface UserUpdate {
  email?: string;
  name?: string;
  status?: Status;
}
```

### FilterVars Types

Typed filter variables for query builder `filter()` and `count()` methods. All fields are optional with an index signature for flexibility.

```typescript
export interface UserFilterVars {
  id?: string;
  email?: string;
  name?: string;
  created_at?: Date;
  status?: Status;
  [key: string]: unknown;
}
```

### JSDoc Constraint Documentation

Properties with constraints, readonly flags, or defaults get JSDoc annotations:

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

One query builder class per object type with methods for common operations:

```typescript
class UserQueryBuilder {
  constructor(private client: DiscClient) {}

  async select(shape?: string): Promise<User[]>;
  async selectById(id: string, shape?: string): Promise<User | null>;
  async filter(
    condition: string,
    variables?: UserFilterVars,
    shape?: string,
  ): Promise<User[]>;
  async insert(data: UserInsert): Promise<User>;
  async update(id: string, data: UserUpdate): Promise<User>;
  async delete(id: string): Promise<User>;
  async count(condition?: string, variables?: UserFilterVars): Promise<number>;
}
```

Insert and update methods use type-aware EdgeQL casts (e.g., `<str>`, `<int32>`, `<datetime>`) based on the schema property types.

### `client.ts` -- Typed Client

Extends the SDK `DiscClient` with query builder properties:

```typescript
import { DiscClient as BaseClient } from "../sdk/mod.ts";

class DiscClient extends BaseClient {
  readonly user: UserQueryBuilder;
  readonly post: PostQueryBuilder;

  constructor(config?: DiscClientConfig) {
    super(config);
    this.user = new UserQueryBuilder(this);
    this.post = new PostQueryBuilder(this);
  }
}
```

### `index.ts` -- Barrel File

Re-exports everything from `types.ts`, `queries.ts`, and `client.ts`.

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

SQL type names (`text`, `integer`, `boolean`, etc.) are also supported for backward compatibility and mapped through to their EdgeQL equivalents.

## TypeScriptGenerator

The core generator class. Normally used through `generateTypeScript()` but can be instantiated directly for fine-grained control:

```typescript
import { TypeScriptGenerator } from "disc/codegen/mod.ts";

const generator = new TypeScriptGenerator(schema, config);
const result = generator.generate();
// result.files: GeneratedFile[]
// result.warnings: string[]
// result.errors: string[]
```
