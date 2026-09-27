/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import {
  compareVersions,
  parsePostgresVersion,
  pgMajor,
  readInstanceVersionFile,
  resolveInstanceVersion,
  writeInstanceVersionFile
} from "./instance-version.ts";

/*** RUNTIME ------------------------------------------ ***/

const SUPPORTED = ["16.4", "17.0", "18.4"];

Deno.test("pgMajor - first component is the major for PostgreSQL 10+", () => {
  assertEquals(pgMajor("16.4"), "16");
  assertEquals(pgMajor("18"), "18");
});

Deno.test("compareVersions - numeric, component-wise", () => {
  assertEquals(compareVersions("16.4", "16.4"), 0);
  assertEquals(compareVersions("16.4", "17.0"), -1);
  assertEquals(compareVersions("16.10", "16.9"), 1);
  assertEquals(compareVersions("16", "16.4"), -1);
});

Deno.test("parsePostgresVersion - reads `postgres --version` output", () => {
  assertEquals(parsePostgresVersion("postgres (PostgreSQL) 16.4\n"), "16.4");
  assertEquals(parsePostgresVersion("postgres (PostgreSQL) 17.2 (Homebrew)\n"), "17.2");
  assertEquals(parsePostgresVersion("postgres (PostgreSQL) 19devel\n"), "19");
  assertEquals(parsePostgresVersion("garbage"), null);
});

Deno.test("resolveInstanceVersion - the recorded version wins when its major matches the data dir", () => {
  assertEquals(
    resolveInstanceVersion({ cached: ["16.4", "18.4"], dataDirMajor: "16", recorded: "16.2", supported: SUPPORTED }),
    "16.2"
  );
});

Deno.test("resolveInstanceVersion - a data dir that disagrees with version.json wins", () => {
  /*** e.g. a 16 data dir restored by hand into an instance recorded as upgraded to 18.4 ***/
  assertEquals(
    resolveInstanceVersion({ cached: ["16.4", "18.4"], dataDirMajor: "16", recorded: "18.4", supported: SUPPORTED }),
    "16.4"
  );
});

Deno.test("resolveInstanceVersion - without a record, the newest cached binaries of the major", () => {
  assertEquals(
    resolveInstanceVersion({ cached: ["16.2", "16.9", "18.4"], dataDirMajor: "16", recorded: null, supported: SUPPORTED }),
    "16.9"
  );
});

Deno.test("resolveInstanceVersion - nothing cached for the major falls back to the supported (downloadable) version", () => {
  assertEquals(
    resolveInstanceVersion({ cached: ["18.4"], dataDirMajor: "17", recorded: null, supported: SUPPORTED }),
    "17.0"
  );
});

Deno.test("resolveInstanceVersion - an unknown major resolves to null", () => {
  assertEquals(
    resolveInstanceVersion({ cached: ["18.4"], dataDirMajor: "15", recorded: null, supported: SUPPORTED }),
    null
  );
});

Deno.test("version.json - round-trips, absent reads as null, missing version is an error", async () => {
  const dir = await Deno.makeTempDir({ prefix: "disc-version-json-" });

  try {
    assertEquals(await readInstanceVersionFile(dir), null);

    await writeInstanceVersionFile(dir, { previousVersion: "16.4", upgradedAt: "2026-01-01T00:00:00.000Z", version: "18.4" });
    assertEquals(await readInstanceVersionFile(dir), {
      previousVersion: "16.4",
      upgradedAt: "2026-01-01T00:00:00.000Z",
      version: "18.4"
    });

    await Deno.writeTextFile(join(dir, "version.json"), "{}");
    await assertRejects(() => readInstanceVersionFile(dir), Error, "no \"version\"");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
