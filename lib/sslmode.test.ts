/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Pins `?sslmode=...` parsing + propagation through the database
 * connection pipeline (gh/geldata#2292). Disc destructures DSNs into
 * an object form before handing them to deno-postgres, which means
 * `?sslmode=require` would otherwise silently disappear. The pipeline
 * now extracts `sslmode` from the URL query string and maps it to the
 * driver's `tls` option shape.
 */

import { assert, assertEquals } from "@std/assert";
import { parseConnectionString, sslmodeToTlsOptions } from "./database.ts";

Deno.test("parseConnectionString — surfaces sslmode from query string", () => {
  const r = parseConnectionString(
    "postgresql://u:p@host:5432/db?sslmode=require"
  );
  assertEquals(r.sslmode, "require");
});

Deno.test("parseConnectionString — handles each supported sslmode", () => {
  for (
    const mode of [
      "disable",
      "prefer",
      "require",
      "verify-ca",
      "verify-full"
    ] as const
  ) {
    const r = parseConnectionString(
      `postgresql://u:p@host:5432/db?sslmode=${mode}`
    );
    assertEquals(r.sslmode, mode, `should preserve ${mode}`);
  }
});

Deno.test("parseConnectionString — invalid sslmode is dropped (not coerced)", () => {
  const r = parseConnectionString(
    "postgresql://u:p@host/db?sslmode=mythical-mode"
  );
  // We refuse to forward unknown modes — the driver default applies.
  assertEquals(r.sslmode, undefined);
});

Deno.test("parseConnectionString — sslmode coexists with other query params", () => {
  const r = parseConnectionString(
    "postgresql://u:p@host/db?application_name=foo&sslmode=verify-full&connect_timeout=10"
  );
  assertEquals(r.sslmode, "verify-full");
});

Deno.test("parseConnectionString — DSN without sslmode leaves it undefined", () => {
  const r = parseConnectionString("postgresql://u:p@host:5432/db");
  assertEquals(r.sslmode, undefined);
});

Deno.test("sslmodeToTlsOptions — maps each mode to driver TLSOptions", () => {
  // Mirrors deno-postgres v0.19.3 connection_params.ts:parseOptionsFromUri.
  // Pinned so the mapping stays in sync with what the driver expects.
  assertEquals(sslmodeToTlsOptions("disable"), {
    enabled: false,
    enforce: false,
    caCertificates: []
  });
  assertEquals(sslmodeToTlsOptions("prefer"), {
    enabled: true,
    enforce: false,
    caCertificates: []
  });
  for (const mode of ["require", "verify-ca", "verify-full"] as const) {
    assertEquals(
      sslmodeToTlsOptions(mode),
      { enabled: true, enforce: true, caCertificates: [] },
      `${mode} should enable + enforce`
    );
  }
  // Undefined / unknown → driver default (no TLS object emitted).
  assertEquals(sslmodeToTlsOptions(undefined), undefined);
});

Deno.test("parseConnectionString — socket DSN ignores sslmode (never relevant)", () => {
  // Unix sockets don't use TLS. Even if a user sets `sslmode` on a
  // socket DSN, the resulting parsed config carries `host_type:
  // "socket"` and the client config branch ignores `sslmode`. This
  // test pins the no-TLS-on-socket invariant.
  const r = parseConnectionString(
    "postgresql://disc@/mydb?host=/tmp/disc.sock&sslmode=require"
  );
  assertEquals(r.host_type, "socket");
  // `sslmode` is undefined for socket DSNs because the URL parser is
  // bypassed — see `parseConnectionString`. The TLS knob would be
  // a no-op anyway.
  assert(r.sslmode === undefined);
});
