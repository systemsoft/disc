# File storage

Built-in file/blob storage for disc (gh/geldata#3567). Local filesystem
backend now; S3-compatible backend is the obvious follow-up.

## Wiring

```ts
import { FileManager, LocalFileStorage } from "disc/lib/file-storage/mod.ts";

const fileManager = new FileManager(db, {
  backend: new LocalFileStorage("/var/disc/files"),
  maxUploadBytes: 100 * 1024 * 1024
});
await fileManager.initialize();

const server = new HttpServer({
  config: {/* ... */},
  protocolHandler,
  authProvider,
  authMiddleware,
  authRoutes,
  fileManager // optional — omit to disable /files routes
});
```

## HTTP routes

All routes require `Authorization: Bearer <JWT>` and operate on the
authenticated user's files only.

| Method | Path              | Body / Headers                                |
| ------ | ----------------- | --------------------------------------------- |
| POST   | `/files`          | raw bytes; `Content-Type` + `x-file-name` opt |
| GET    | `/files`          | (none) — returns `{ "files": [...] }`         |
| GET    | `/files/:id`      | (none) — binary, with `Content-Disposition`   |
| GET    | `/files/:id/meta` | (none) — JSON metadata                        |
| DELETE | `/files/:id`      | (none) — `204` on success                     |

## Behavior

- **Content-addressed dedup.** Uploaded blobs are keyed by their SHA-256
  hash. Two users uploading identical bytes share one underlying blob;
  metadata rows are distinct. Delete removes the blob only when the
  last metadata row referencing it is gone.
- **Owner-only access.** `read` / `delete` reject when the requesting
  user isn't the owner. Public-vs-private ACLs are a follow-up.
- **Atomic writes.** `LocalFileStorage` writes to a temp file in the
  same directory, then renames — the partial state never appears.
- **Path-traversal safe.** Storage keys are validated against a strict
  alphabet (`[a-zA-Z0-9._-]+`); `..` and `/` are rejected.
- **2-level fanout.** Keys ≥4 chars are stored under `<aa>/<bb>/<key>`
  to keep any single directory under ~256 subdirs.
- **Size cap.** `FileManager.maxUploadBytes` defaults to 100 MiB.
  Throws `FileTooLargeError` (HTTP 413) on overage.

## Out of scope (future)

- S3-compatible backend
- Multipart / chunked uploads
- Pre-signed URLs
- Image transformations
- Public-vs-private ACL flag
