/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `disc restart` finds the project's on-disk instance.
 *
 * A fresh CLI process knows no instances until it reads them from
 * `$DISC_HOME/instances`. `start`, `stop` and `status` discover them first;
 * `restart` has to as well, or it reports "No PostgreSQL instance found" for
 * an instance that exists.
 *
 * Requires PostgreSQL binaries: set DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { PostgresManager } from "../postgres/manager.ts";
import { canRunPgTests, findPgBinDir } from "../tests/pg-test-harness.ts";
import { ConsoleCapture } from "../tests/test-utils.ts";
import { CLICommands } from "./commands.ts";

const PROJECT = "restart-probe";

Deno.test({
  name: "PG: disc restart restarts the project's on-disk instance",
  ignore: !canRunPgTests() || findPgBinDir() === undefined,
  fn: async () => {
    const binDir = findPgBinDir()!;
    /*** Under /tmp to keep the Unix socket path short. ***/
    const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "disc-rs-" });
    const discHome = join(root, "home");
    const projectDir = join(root, "project");
    const pgBinaryDir = join(root, "pg");
    const previous = { binaryDir: Deno.env.get("DISC_PG_BINARY_DIR"), discHome: Deno.env.get("DISC_HOME") };
    const cwd = Deno.cwd();
    const capture = new ConsoleCapture();
    let manager: PostgresManager | undefined;

    try {
      /*** Point the binary cache at the local PostgreSQL so recovering the instance from disk
           doesn't download one. ***/
      await Deno.mkdir(join(pgBinaryDir, "18.4"), { recursive: true });
      await Deno.symlink(binDir, join(pgBinaryDir, "18.4", "bin"));
      Deno.env.set("DISC_PG_BINARY_DIR", pgBinaryDir);
      Deno.env.set("DISC_HOME", discHome);

      await Deno.mkdir(projectDir, { recursive: true });
      await Deno.writeTextFile(join(projectDir, "disc.toml"), `name = "${PROJECT}"\n`);

      /*** Create and start the instance in a separate manager, as an earlier `disc init` /
           `disc start` process would. ***/
      manager = new PostgresManager(join(discHome, "instances"));
      await manager.createInstance(PROJECT, { pgBinDir: binDir });
      await manager.startInstance(PROJECT, false);

      Deno.chdir(projectDir);
      capture.start();
      await new CLICommands().restart({ _: ["restart"] });
      capture.stop();

      const output = [...capture.getLogs(), ...capture.getErrors()].join("\n");
      assert(!output.includes("No PostgreSQL instance found"), output);
      assertStringIncludes(output, "PostgreSQL restarted successfully");

      const status = await manager.getInstanceStatus(PROJECT);
      assertEquals(status?.running, true, "the instance is running after restart");
    } finally {
      capture.stop();
      Deno.chdir(cwd);

      if (manager)
        await manager.stopInstance(PROJECT).catch(() => {});

      for (const [key, value] of [["DISC_PG_BINARY_DIR", previous.binaryDir], ["DISC_HOME", previous.discHome]] as const) {
        if (value === undefined)
          Deno.env.delete(key);
        else
          Deno.env.set(key, value);
      }

      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  }
});
