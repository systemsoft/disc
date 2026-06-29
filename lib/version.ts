/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Canonical Disc server/tool version.
 *
 * Single source of truth for the version reported by the server (`/`, `/stats`,
 * EdgeQL protocol handshake), the OpenAPI spec, and the LSP server. The version
 * scaffolded into a *new user project* (see `cli/init.ts`) is intentionally
 * separate — that tracks the user's project, not Disc itself.
 */

export const DISC_VERSION = "2026.06.29";
