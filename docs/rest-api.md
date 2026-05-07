# REST API (schema-derived)

> Disc-original feature #2. See `docs/disc-original-features.md` and Bundle J.

Disc auto-generates a conventional REST surface from your schema. Every
non-abstract object type gets the standard five verbs plus per-link
collection endpoints, and a matching OpenAPI 3.1 spec is published at
`/api/openapi.json`.

The REST routes do **not** bypass the EdgeQL pipeline. Each request
synthesizes an EdgeQL string and runs it through the same protocol
handler that powers `/query`, so access policies, server-wide read-only
mode, and the `requireAuth` HTTP gate compose without extra work.

## Endpoints

For every type `T` in the schema:

| Method   | Path                 | Description                           |
| -------- | -------------------- | ------------------------------------- |
| `GET`    | `/api/T`             | List with filter / order / pagination |
| `GET`    | `/api/T/{id}`        | Single object by id (`uuid`)          |
| `POST`   | `/api/T`             | Insert                                |
| `PATCH`  | `/api/T/{id}`        | Partial update                        |
| `DELETE` | `/api/T/{id}`        | Delete (idempotent: 204 either way)   |
| `GET`    | `/api/T/{id}/{link}` | Linked collection (offset/limit only) |

Plus:

| Method | Path                | Description                      |
| ------ | ------------------- | -------------------------------- |
| `GET`  | `/api/openapi.json` | OpenAPI 3.1 spec for the surface |

## Query parameters (list endpoint)

### Filters

```
GET /api/User?name=Ada
GET /api/User?email__in=a@x.com,b@y.com
GET /api/User?bio__contains=author
```

| Operator       | Form                  | EdgeQL emitted                   |
| -------------- | --------------------- | -------------------------------- |
| Equality       | `?prop=value`         | `.prop = 'value'`                |
| Set membership | `?prop__in=a,b,c`     | `.prop in {'a', 'b', 'c'}`       |
| Substring      | `?prop__contains=foo` | `contains(.prop, 'foo')` (ILIKE) |

Unknown property names → 400 with the offending field named.
Bundle J keeps the operator vocabulary intentionally small; richer
operators (e.g., `__lt`, `__gte`, `__regex`, link-traversal filters) are
follow-ups.

### Pagination

```
GET /api/User?limit=10&offset=20&order_by=name
GET /api/User?order_by=-createdAt
```

`order_by=-prop` sorts descending. `order_by=prop` sorts ascending.

## Bodies (POST / PATCH)

JSON only, with `Content-Type: application/json`.

```jsonc
// POST /api/User
{
  "name": "Ada Lovelace",
  "email": "ada@example.com",
}
```

Links are passed by id:

```jsonc
// POST /api/Post
{
  "title": "Notes on the Analytical Engine",
  "author": "61f4c7ad-…",
}
```

Unknown fields are rejected with 400. The compiler runs its full type-
and constraint-check pipeline downstream, so type mismatches surface as
the standard EdgeQL compile error in the response.

PATCH bodies require at least one field; sending `{}` returns 400.

## Default response shape

`GET /api/T` and `GET /api/T/{id}` project a default shape derived from
the schema:

- All non-computed properties are included.
- Properties annotated `rest::hidden` are excluded.
- Links are excluded by default — use the linked-collection endpoint to
  fetch them. Annotate a link with `rest::expand` to inline it.

```edgeql
type User {
  required email: str { @rest::hidden };
  required name: str;
  multi posts: Post { @rest::expand };
}
```

(SDL syntax: `annotation rest::hidden;` on the property/link body.)

The expanded linked collection uses the _target type's_ default REST
shape recursively, so its own `rest::hidden` / `rest::expand`
annotations apply.

## Status codes

| Code | When                                                                             |
| ---- | -------------------------------------------------------------------------------- |
| 200  | GET / PATCH success                                                              |
| 201  | POST success                                                                     |
| 204  | DELETE success (returns no body)                                                 |
| 400  | Unknown filter/body field, malformed UUID, empty PATCH body, parse/compile error |
| 401  | `requireAuth=true` and missing/invalid bearer token                              |
| 403  | Access policy denied                                                             |
| 404  | Type not in schema, or row not found                                             |
| 405  | Method not allowed for the route                                                 |
| 408  | Request exceeded `requestTimeout`                                                |
| 503  | `readOnly=true` and the request would write                                      |

## Disabling the REST surface

REST is on by default. Three ways to turn it off:

```toml
# disc.toml
[server]
enable_rest = false
```

```bash
# environment variable
DISC_ENABLE_REST=false
```

```typescript
// programmatic
new DiscServer({ enableRest: false /* ... */ });
```

When disabled, `/api/*` returns 404 — the OpenAPI spec is also withheld.

## OpenAPI

```
GET /api/openapi.json
```

Returns a 3.1.0 spec covering every non-abstract object type. Per-type
component schemas reflect the default REST shape (so hidden fields
don't leak via documentation). When `requireAuth=true` the spec emits
a `bearerAuth` security scheme.

## Limits and follow-ups

Out of scope for Bundle J:

- Multipart bodies, CSV/protobuf payloads
- Filter operators beyond `=`, `__in`, `__contains`
- Link-traversal filters (`?author__name=…`)
- `order_by` for linked collections
- Per-type `@rest::route` overrides (custom path naming)
- Field-level write protection beyond `id` (currently, properties marked
  `@readonly` are still acceptable in POST/PATCH bodies; the compiler
  rejects them downstream)

These are easy extensions on the same foundation when the demand is
clear; nothing about the current design forecloses any of them.
