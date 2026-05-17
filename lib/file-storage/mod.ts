/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * File storage module — local-filesystem backend + metadata manager.
 * Exposed primitives: `FileManager`, `LocalFileStorage`, the
 * `FileStorageBackend` interface, and the error classes.
 *
 * (gh/geldata#3567)
 */

export {
  FileAccessDeniedError,
  FileManager,
  FileNotFoundError,
  FileTooLargeError
} from "./manager.ts";
export type { FileManagerOptions } from "./manager.ts";

export { LocalFileStorage } from "./local.ts";

export type { FileMetadata, FileStorageBackend, FileUpload } from "./types.ts";
